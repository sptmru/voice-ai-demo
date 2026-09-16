import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { databaseUrl } from '../packages/db/src/config.js';
import { PostgresRepository } from '../packages/db/src/index.js';
import { migrate } from '../packages/db/src/migrate.js';
import { SupportRuntime } from '../packages/core/src/runtime.js';
import { createTextAgent, modelConfig } from '../packages/core/src/text-agent.js';
import { RagService, EMBEDDING_MODEL, EMBEDDING_SIGNATURE } from '../packages/rag/src/index.js';
import { getCalendarService } from '../packages/integrations/src/calendar.js';
import { seedOperationalData, seedRepairKnowledge } from './seed.js';
import { checkConversationTurn, type ConversationCase } from './lib/conversation-quality.js';

const live = process.argv.includes('--live-text');
if (live && process.env.EVAL_ALLOW_LIVE !== '1')
  throw new Error(
    'Live evaluation makes billable model requests. Set EVAL_ALLOW_LIVE=1 and explicitly pass --live-text.',
  );
// Independent from provider selection: an evaluation must never contact the user's Google calendar.
for (const name of ['GOOGLE_CALENDAR_ID', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'])
  delete process.env[name];
const calendar = getCalendarService('rehearsal');
if (calendar.status().configured)
  throw new Error('Conversation evaluation requires a fresh local demo calendar.');
const maxModelRequests = Math.max(
  1,
  Math.min(100, Math.floor(Number(process.env.CONVERSATION_EVAL_MAX_MODEL_REQUESTS) || 40)),
);
let modelRequests = 0;
const boundedFetch: typeof fetch = async (input, init) => {
  if (modelRequests >= maxModelRequests)
    throw new Error('Conversation evaluation model-request budget exhausted');
  modelRequests++;
  return fetch(input, init);
};
const textAgent = live ? createTextAgent(modelConfig('text'), boundedFetch) : undefined;
if (live && !textAgent)
  throw new Error('Configure TEXT_PROVIDER and its API key before requesting live evaluation.');
const mode = live ? 'live-text' : 'deterministic';
const datasetPath = resolve(process.env.CONVERSATION_EVAL_DATASET || 'docs/evaluation/conversations.en.json');
const dataset = JSON.parse(await readFile(datasetPath, 'utf8')) as ConversationCase[];
const cases = process.env.CONVERSATION_EVAL_CASE
  ? dataset.filter((item) => process.env.CONVERSATION_EVAL_CASE!.split(',').includes(item.id))
  : dataset;
if (!cases.length) throw new Error('No conversation evaluation cases selected.');
const reportPath = resolve(
  process.env.CONVERSATION_EVAL_REPORT || `artifacts/conversation-evaluation-${mode}.json`,
);
const schema = `relay_conversation_eval_${randomUUID().replaceAll('-', '')}`;
const connectionString = process.env.TEST_DATABASE_URL || databaseUrl();
const admin = new pg.Pool({ connectionString });
const database = new pg.Pool({ connectionString, options: `-c search_path=${schema},public` });
const results: any[] = [];
let created = false;
try {
  await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
  await admin.query(`CREATE SCHEMA ${schema}`);
  created = true;
  await migrate(database);
  await seedOperationalData(database);
  await seedRepairKnowledge(database);
  const rag = new RagService(database);
  const warmup = await rag.warmup();
  const repo = new PostgresRepository(database);
  const runtime = new SupportRuntime(repo, rag, undefined, textAgent);
  for (const item of cases) {
    const session = await runtime.startSession(item.scenario, 'rehearsal');
    const turns = [];
    for (const [index, turn] of item.turns.entries()) {
      const before = await repo.getSession(session.id);
      const previousEvents = await repo.getEvents(session.id);
      const previousActions = await repo.getActions(session.id);
      const offeredSlotsBefore = before.snapshot.business?.offeredSlots ?? [];
      let answer = '';
      let failure: string | undefined;
      let confirmationResult: unknown;
      const started = performance.now();
      try {
        if (turn.before === 'occupy-first-slot') {
          const slot = offeredSlotsBefore[0];
          if (!slot) throw new Error('Conflict fixture requires a previously offered slot.');
          await calendar.book({
            ...slot,
            sessionId: `evaluation-competitor-${randomUUID()}`,
            bookingKey: 'occupied',
            summary: 'Fictional evaluation reservation',
          });
        }
        if (turn.confirmation) {
          const pending = (await repo.getConfirmations(session.id))
            .filter((entry) => entry.status === 'pending')
            .at(-1);
          if (!pending) throw new Error('Expected application confirmation card was absent.');
          confirmationResult = await runtime.confirm(session.id, pending.id, turn.confirmation === 'approve');
        } else if (turn.user) answer = (await runtime.message(session.id, turn.user)).text;
        else throw new Error('Evaluation turn must provide user text or a confirmation action.');
      } catch (error) {
        failure = error instanceof Error ? error.message : 'Evaluation turn failed';
      }
      const after = await repo.getSession(session.id);
      const allEvents = await repo.getEvents(session.id);
      const events = allEvents.filter((event) => event.id > (previousEvents.at(-1)?.id ?? 0));
      const actions = await repo.getActions(session.id);
      const confirmations = await repo.getConfirmations(session.id);
      const appointment = await repo.getAppointment?.(session.id);
      const groundingContext = JSON.stringify({
        // Numeric support is a bounded diagnostic, not a semantic entailment judge.
        tools: allEvents.filter((event) => event.type === 'tool.completed').map((event) => event.payload),
        sources: allEvents
          .filter((event) => event.type === 'retrieval.completed')
          .map((event) => event.payload),
        operational: after.snapshot,
        offeredOptionLabels: after.snapshot.business?.offeredSlots?.map((_, index) => index + 1),
        offeredLocalTimes: after.snapshot.business?.offeredSlots?.map((slot) =>
          new Intl.DateTimeFormat('en-GB', {
            timeZone: after.snapshot.business?.calendarTimeZone ?? 'Asia/Yerevan',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }).format(new Date(slot.start)),
        ),
        user: allEvents
          .filter((event) => event.type === 'transcript' && event.payload.role === 'user')
          .map((event) => event.payload.text),
      });
      const checks = checkConversationTurn(turn, {
        answer,
        events,
        session: after,
        actions,
        previousActions,
        confirmations,
        appointment,
        offeredSlotsBefore,
        groundingContext,
        mode,
      });
      if (failure) checks.push({ name: 'turn-executed', pass: false, detail: failure });
      const pass = checks.every((check) => check.pass);
      turns.push({
        index: index + 1,
        user: turn.user,
        confirmation: turn.confirmation,
        fixture: turn.before,
        answer,
        confirmationResult,
        pass,
        checks,
        elapsedMs: Math.round(performance.now() - started),
        evidence: events
          .filter((event) =>
            ['retrieval.completed', 'tool.completed', 'tool.failed', 'confirmation.requested'].includes(
              event.type,
            ),
          )
          .map((event) => ({ type: event.type, payload: event.payload })),
        context: after.snapshot.repair,
        business: after.snapshot.business,
        expectation: turn.expect,
        actions,
        confirmations,
        appointment,
        outcome: after.outcome,
      });
      console.log(
        `${pass ? 'PASS' : 'FAIL'} ${item.id} turn ${index + 1}${
          pass
            ? ''
            : ': ' +
              checks
                .filter((check) => !check.pass)
                .map((check) => check.name)
                .join(', ')
        }`,
      );
    }
    results.push({
      id: item.id,
      description: item.description,
      scenario: item.scenario,
      pass: turns.every((turn) => turn.pass),
      turns,
    });
  }
  const turns = results.flatMap((item) => item.turns);
  const summary = {
    evaluatedAt: new Date().toISOString(),
    mode,
    provider: textAgent?.provider ?? null,
    model: textAgent?.model ?? null,
    modelRequests,
    maxModelRequests: live ? maxModelRequests : 0,
    embeddingModel: EMBEDDING_MODEL,
    embeddingSignature: EMBEDDING_SIGNATURE,
    warmup,
    dataset: datasetPath,
    conversations: results.length,
    conversationsPassed: results.filter((item) => item.pass).length,
    turns: turns.length,
    turnsPassed: turns.filter((turn) => turn.pass).length,
    checks: turns.flatMap((turn) => turn.checks).length,
    checksPassed: turns.flatMap((turn) => turn.checks).filter((check) => check.pass).length,
    calendar: 'isolated local demo; Google credentials disabled',
    note:
      mode === 'deterministic'
        ? 'Actual deterministic fallback answers and real local retrieval/tools. No generative LLM, microphone or speech recognition evaluated.'
        : 'Actual generated text answers with local tools and real retrieval. Billable text-model requests; no voice, microphone or speech recognition evaluated.',
    limitations:
      'Freshly authored multi-turn scenarios, separate from the 54 retrieval cases; once used for tuning they are regression tests, not permanently held-out evidence. Rule-based claim/citation checks are bounded diagnostics, not proof that every statement is entailed. Inspect transcripts and source excerpts in failures. Disposable database schema removed after evaluation.',
  };
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ summary, cases: results }, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Report: ${reportPath}`);
  if (results.some((item) => !item.pass)) process.exitCode = 1;
} finally {
  await database.end();
  if (created) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
