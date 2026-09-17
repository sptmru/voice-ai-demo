import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresRepository } from '../packages/db/src/index.js';
import { migrate } from '../packages/db/src/migrate.js';
import { RagService } from '../packages/rag/src/index.js';
import { seedOperationalData } from '../scripts/seed.js';
import { SupportRuntime } from '../packages/core/src/runtime.js';
import { buildScenarioPrompt } from '../packages/core/src/prompt.js';
import type { CallOutcome, RetrievalResult } from '../packages/core/src/domain.js';
import type { ToolExecutionResult } from '../packages/core/src/executor.js';
import {
  GeminiLiveProvider,
  OpenAIRealtimeProvider,
  type ProviderSocket,
  type RealtimeVoiceSession,
  type VoiceEvent,
} from '../packages/voice/src/index.js';

/** Only the upstream provider wire is mocked. PostgreSQL, embeddings, RAG and executor are real. */
class UpstreamFixture extends EventEmitter implements ProviderSocket {
  readyState = 0;
  bufferedAmount = 0;
  sent: Record<string, any>[] = [];
  send(data: string, callback?: (error?: Error) => void) {
    this.sent.push(JSON.parse(data));
    callback?.();
  }
  close(code = 1000) {
    this.readyState = 3;
    this.emit('close', code);
  }
  terminate() {
    this.close(1006);
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
  deliver(event: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }
}

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'scripted provider protocol fixtures — not live Gemini/OpenAI validation',
  () => {
    const schema = `relay_provider_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    const repo = new PostgresRepository(pool);
    const rag = new RagService(pool);
    const runtime = new SupportRuntime(repo, rag);
    beforeAll(async () => {
      await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
      await admin.query(`CREATE SCHEMA ${schema}`);
      await migrate(pool);
      await seedOperationalData(pool);
      for (const filename of ['repair/workshop-preparation.md']) {
        const content = await readFile(new URL(`../docs/knowledge/${filename}`, import.meta.url), 'utf8');
        await rag.ingest({
          title: /^#\s+(.+)$/m.exec(content)?.[1] ?? filename,
          source: `docs/knowledge/${filename}`,
          content,
          type: 'markdown',
        });
      }
    });
    afterAll(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    });

    it('runs the identical M1 evidence/tool/outcome sequence through both real adapters and persists equivalent cases', async () => {
      const outcomes: CallOutcome[] = [];
      for (const providerId of ['gemini', 'openai'] as const) {
        const support = await runtime.startSession('repair-advice');
        const socket = new UpstreamFixture();
        const events: VoiceEvent[] = [];
        const executionResults = new Map<string, ToolExecutionResult>();
        let work = Promise.resolve();
        let voice: RealtimeVoiceSession;
        const onEvent = (event: VoiceEvent) => {
          events.push(event);
          if (event.type === 'toolCall')
            work = work.then(async () => {
              const result = await runtime.executeTool(support.id, {
                id: event.id,
                name: event.name,
                input: event.input,
              });
              executionResults.set(event.id, result);
              await voice.sendToolResult(result);
            });
        };
        const definitions = runtime.executor.tools.filter((tool) => tool.permission !== 'human-only');
        const config = {
          instructions: buildScenarioPrompt(support),
          tools: definitions,
          onEvent,
          sdpOffer: 'v=0\r\ns=Protocol fixture\r\n',
        };
        const provider =
          providerId === 'gemini'
            ? new GeminiLiveProvider({ apiKey: 'fixture-only', socketFactory: () => socket })
            : new OpenAIRealtimeProvider({
                apiKey: 'fixture-only',
                socketFactory: () => socket,
                fetcher: async (url) =>
                  String(url).endsWith('/hangup')
                    ? new Response(null, { status: 200 })
                    : new Response('v=0\r\ns=Fixture answer\r\n', {
                        status: 201,
                        headers: { Location: '/v1/realtime/calls/rtc_fixture' },
                      }),
              });
        const connecting = provider.connect(config);
        for (let i = 0; i < 10; i++) await Promise.resolve();
        socket.open();
        if (providerId === 'gemini') socket.deliver({ setupComplete: {} });
        else {
          socket.deliver({ type: 'session.created', session: { id: 'fixture-session' } });
          socket.deliver({ type: 'session.updated', session: { id: 'fixture-session' } });
        }
        voice = await connecting;
        let ordinal = 0;
        const invoke = async <T>(name: string, input: unknown = {}): Promise<T> => {
          const id = `${providerId}:call:${++ordinal}`;
          if (providerId === 'gemini')
            socket.deliver({ toolCall: { functionCalls: [{ id, name, args: input }] } });
          else {
            socket.deliver({ type: 'response.created', response: { id: `response-${ordinal}` } });
            socket.deliver({
              type: 'response.done',
              response: {
                id: `response-${ordinal}`,
                status: 'completed',
                output: [
                  {
                    type: 'function_call',
                    status: 'completed',
                    call_id: id,
                    name,
                    arguments: JSON.stringify(input),
                  },
                ],
              },
            });
          }
          await work;
          const executed = executionResults.get(id)!;
          expect(executed.status).toBe('completed');
          const returned =
            providerId === 'gemini'
              ? socket.sent.find((e) => e.toolResponse?.functionResponses?.[0]?.id === id)?.toolResponse
                  .functionResponses[0].response.result
              : JSON.parse(
                  socket.sent.find((e) => e.item?.type === 'function_call_output' && e.item.call_id === id)
                    ?.item.output ?? 'null',
                );
          expect(returned).toEqual(executed);
          return executed.result as T;
        };
        try {
          const customer = await invoke<{ company: string }>('get_customer');
          await invoke('update_repair_context', {
            appliance: 'washing-machine',
            model: 'W100',
            issue: 'Will not drain',
          });
          const evidence = await invoke<RetrievalResult>('search_knowledge_base', {
            query: 'workshop diagnosis preparation',
            limit: 4,
          });
          expect(evidence.chunks.length).toBeGreaterThan(0);
          const diagnosis = 'The customer needs workshop diagnosis. Appliance repair is not confirmed.';
          const ticket = await invoke<{ id: string }>('create_support_ticket', {
            subject: 'Appliance will not drain',
            description: diagnosis,
            severity: 'high',
          });
          const outcome = await invoke<CallOutcome>('complete_support_case', {
            intent: 'repair_support',
            severity: 'high',
            product: 'Relay Workshop',
            issue: 'Appliance will not drain',
            diagnosis,
            resolved: false,
            nextAction: 'Arrange workshop diagnosis.',
          });
          expect(outcome.customer).toBe(customer.company);
          expect(outcome.ticketId).toBe(ticket.id);
          expect(outcome.actions).toContain('tool:search_knowledge_base');
          expect(outcome.actions).toContain(`ticket:${ticket.id}`);
          expect((await repo.getSession(support.id)).outcome).toEqual(outcome);
          expect(await repo.getTickets(support.id)).toHaveLength(1);
          expect((await repo.getEvents(support.id)).filter((e) => e.type === 'tool.completed')).toHaveLength(
            5,
          );
          expect(events.filter((e) => e.type === 'toolCall').map((e) => e.name)).toEqual([
            'get_customer',
            'update_repair_context',
            'search_knowledge_base',
            'create_support_ticket',
            'complete_support_case',
          ]);
          if (providerId === 'gemini') socket.deliver({ serverContent: { turnComplete: true } });
          else {
            socket.deliver({ type: 'response.created', response: { id: 'final' } });
            socket.deliver({
              type: 'response.done',
              response: { id: 'final', status: 'completed', output: [] },
            });
          }
          expect(events.filter((e) => e.type === 'turn' && e.phase === 'completed')).toHaveLength(1);
          outcomes.push(outcome);
        } finally {
          await voice.close();
          await work;
        }
      }
      const comparable = (outcome: CallOutcome) => ({
        ...outcome,
        ticketId: null,
        actions: outcome.actions.filter((action) => !action.startsWith('ticket:')),
      });
      expect(comparable(outcomes[0])).toEqual(comparable(outcomes[1]));
      expect(outcomes[0].ticketId).not.toBe(outcomes[1].ticketId);
    });
  },
);
