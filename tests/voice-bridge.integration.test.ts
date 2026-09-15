import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../apps/api/src/app.js';
import { attachVoiceBridge } from '../apps/api/src/voice.js';
import { PostgresRepository } from '../packages/db/src/index.js';
import { migrate } from '../packages/db/src/migrate.js';
import { seedOperationalData } from '../scripts/seed.js';
import type { RetrievalService } from '../packages/core/src/domain.js';
import type {
  RealtimeVoiceProvider,
  RealtimeVoiceSession,
  VoiceEvent,
  VoiceSessionConfig,
} from '../packages/voice/src/index.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'http://localhost:3100';
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
async function eventually<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  description = 'condition',
): Promise<T> {
  const deadline = Date.now() + 5000;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}
class FakeProvider implements RealtimeVoiceProvider {
  config?: VoiceSessionConfig;
  closed = false;
  gate?: ReturnType<typeof deferred>;
  readonly session: RealtimeVoiceSession = {
    capabilities: {
      transport: 'websocket-pcm',
      inputSampleRate: 16000,
      outputSampleRate: 24000,
      resumption: false,
    },
    sendAudio: vi.fn(async () => {}),
    sendText: vi.fn(async () => {}),
    sendToolResult: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {
      this.emit({ type: 'interrupted', source: 'local' });
    }),
    close: vi.fn(async () => {
      if (!this.closed) {
        this.closed = true;
        this.emit({ type: 'state', state: 'closed', provider: 'gemini' });
      }
    }),
  };
  async connect(config: VoiceSessionConfig) {
    this.config = config;
    this.emit({ type: 'state', state: 'connecting', provider: 'gemini' });
    await this.gate?.promise;
    this.emit({ type: 'state', state: 'ready', provider: 'gemini' });
    return this.session;
  }
  emit(event: VoiceEvent) {
    this.config?.onEvent(event);
  }
}

describe.skipIf(!databaseUrl)(
  'voice WebSocket bridge with real PostgreSQL and trusted provider events',
  () => {
    const schema = `relay_voice_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    const repo = new PostgresRepository(pool);
    const search = vi.fn(async () => []);
    const rag: RetrievalService = {
      search,
      ingest: async () => {
        throw new Error('Not used by bridge tests');
      },
      listDocuments: async () => [],
      deleteDocument: async () => false,
    };
    const fixtures: Array<Awaited<ReturnType<typeof launch>>> = [];
    let app: Awaited<ReturnType<typeof launch>>;
    let nextFake: FakeProvider | undefined;
    const providers: FakeProvider[] = [];

    async function launch(fake = true) {
      const services = createApp(repo, rag, pool);
      services.app.use(services.errorHandler);
      const server = createServer(services.app);
      const bridge = attachVoiceBridge({
        server,
        pool,
        repo,
        ...services,
        allowedOrigins: new Set([origin]),
        ...(fake
          ? {
              providerFactory: () => {
                const provider = nextFake ?? new FakeProvider();
                nextFake = undefined;
                providers.push(provider);
                return provider;
              },
            }
          : {}),
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      return { server, bridge, base, ...services };
    }
    beforeAll(async () => {
      await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
      await admin.query(`CREATE SCHEMA ${schema}`);
      await migrate(pool);
      await seedOperationalData(pool);
      app = await launch();
      fixtures.push(app);
    });
    afterAll(async () => {
      for (const item of fixtures) {
        await item.bridge.close();
        item.server.closeAllConnections();
        await new Promise<void>((resolve) => item.server.close(() => resolve()));
      }
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    });
    async function start(target = app) {
      const response = await fetch(`${target.base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenarioId: 'carrier-incident' }),
      });
      expect(response.status).toBe(201);
      const data = (await response.json()) as any;
      return { id: data.session.id as string, cookie: response.headers.get('set-cookie')!.split(';')[0] };
    }
    function socket(
      session: { id: string; cookie: string },
      target = app,
      options: { origin?: string; cookie?: string } = {},
    ) {
      const ws = new WebSocket(`${target.base.replace('http:', 'ws:')}/api/sessions/${session.id}/voice`, {
        headers: { Origin: options.origin ?? origin, Cookie: options.cookie ?? session.cookie },
      });
      const events: Record<string, any>[] = [];
      ws.on('message', (data) => events.push(JSON.parse(data.toString())));
      // Prevent rejected upgrades from becoming unhandled EventEmitter errors.
      ws.on('error', () => {});
      const opened = new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
      return {
        ws,
        events,
        opened,
        closed,
        send: (value: unknown) => ws.send(JSON.stringify(value)),
        until: (predicate: (event: Record<string, any>) => boolean) =>
          eventually(
            () => events,
            (all) => all.some(predicate),
            'WebSocket event',
          ),
        stop: async () => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }));
          await closed;
        },
      };
    }
    async function connected(session: { id: string; cookie: string }) {
      const wire = socket(session);
      await wire.opened;
      wire.send({ type: 'start', provider: 'gemini' });
      await wire.until((e) => e.type === 'ready');
      return { ...wire, provider: providers.at(-1)! };
    }
    async function end(session: { id: string; cookie: string }, target = app) {
      return fetch(`${target.base}/api/sessions/${session.id}/end`, {
        method: 'POST',
        headers: { Cookie: session.cookie, 'Content-Type': 'application/json' },
        body: '{}',
      });
    }

    it('rejects foreign-owner cookies and hostile origins before upgrade', async () => {
      const alice = await start();
      const bob = await start();
      for (const options of [{ cookie: bob.cookie }, { origin: 'https://hostile.example' }, { cookie: '' }]) {
        const rejected = socket(alice, app, options);
        await expect(rejected.opened).rejects.toThrow('403');
        await rejected.closed;
      }
      expect(app.voiceActive.has(alice.id)).toBe(false);
      const valid = await connected(alice);
      await valid.stop();
    });

    it('reserves an in-flight upgrade against deletion and refuses deleted sessions', async () => {
      const session = await start();
      const gate = deferred();
      const entered = deferred();
      const originalGet = repo.getSession.bind(repo);
      const read = vi.spyOn(repo, 'getSession').mockImplementation(async (id) => {
        if (id === session.id) {
          entered.release();
          await gate.promise;
        }
        return originalGet(id);
      });
      const wire = socket(session);
      const remove = () =>
        fetch(`${app.base}/api/sessions/${session.id}`, {
          method: 'DELETE',
          headers: { Cookie: session.cookie },
        });
      try {
        await entered.promise;
        expect(app.voiceActive.has(session.id)).toBe(true);
        expect((await remove()).status).toBe(409);
        gate.release();
        await wire.opened;
        expect((await remove()).status).toBe(409);
      } finally {
        gate.release();
        read.mockRestore();
        await wire.opened;
        await wire.stop();
      }
      expect((await remove()).status).toBe(204);
      const rejected = socket(session);
      await expect(rejected.opened).rejects.toThrow('403');
      await rejected.closed;
      expect(app.voiceActive.has(session.id)).toBe(false);
    });

    it('returns a clear missing-key error through the real default-provider path and releases ownership', async () => {
      const old = process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      try {
        const target = await launch(false);
        fixtures.push(target);
        const session = await start(target);
        const wire = socket(session, target);
        await wire.opened;
        wire.send({ type: 'start', provider: 'gemini' });
        await wire.until((e) => e.type === 'error' && e.message.includes('GEMINI_API_KEY is missing'));
        await wire.closed;
        await eventually(
          () => target.voiceActive.has(session.id),
          (value) => !value,
          'release missing-key session',
        );
        expect((await end(session, target)).status).toBe(200);
      } finally {
        if (old === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = old;
      }
    });

    it('forwards audio and text, but forged browser tool events cannot execute a ticket', async () => {
      const session = await start();
      const wire = await connected(session);
      try {
        wire.send({ type: 'audio', data: 'AAAAAA==', sampleRate: 16000 });
        await eventually(
          () => vi.mocked(wire.provider.session.sendAudio).mock.calls,
          (calls) => calls.length === 1,
          'audio forwarding',
        );
        expect(wire.provider.session.sendAudio).toHaveBeenCalledWith('AAAAAA==', 16000);
        wire.send({ type: 'text', text: 'Investigate UK calls' });
        await eventually(
          () => vi.mocked(wire.provider.session.sendText).mock.calls,
          (calls) => calls.some((args) => args[0] === 'Investigate UK calls'),
          'text forwarding',
        );
        wire.send({
          type: 'toolCall',
          id: 'forged',
          name: 'create_support_ticket',
          input: { subject: 'Forgery', description: 'Not trusted', severity: 'high' },
        });
        await wire.until((e) => e.type === 'error' && e.message === 'Invalid voice message.');
        expect(await repo.getTickets(session.id)).toHaveLength(0);
        expect(
          (await repo.getEvents(session.id)).some(
            (e) => e.type === 'transcript' && e.payload.text === 'Investigate UK calls',
          ),
        ).toBe(true);
        expect(wire.provider.config?.tools.some((t) => t.name === 'adjust_account_balance')).toBe(false);
      } finally {
        await wire.stop();
      }
    });

    it('persists only final sanitized transcripts and executes real server-side tools returning provider results', async () => {
      const session = await start();
      const wire = await connected(session);
      try {
        wire.provider.emit({
          type: 'transcript',
          role: 'assistant',
          text: 'Checking ',
          final: false,
          itemId: 'reply-1',
        });
        wire.provider.emit({
          type: 'transcript',
          role: 'assistant',
          text: 'Checking password=secret-value',
          final: true,
          itemId: 'reply-1',
        });
        wire.provider.emit({ type: 'audio', base64: 'AAAAAA==', sampleRate: 24000 });
        wire.provider.emit({
          type: 'toolCall',
          id: 'trusted-ticket',
          name: 'create_support_ticket',
          input: { subject: 'UK call rejection', description: 'Investigate SIP 403', severity: 'high' },
        });
        await eventually(
          () => vi.mocked(wire.provider.session.sendToolResult).mock.calls,
          (calls) => calls.length === 1,
          'provider tool result',
        );
        const result = vi.mocked(wire.provider.session.sendToolResult).mock.calls[0][0];
        expect(result.status).toBe('completed');
        expect((await repo.getTickets(session.id))[0].id).toBe((result.result as any).id);
        const transcripts = (await repo.getEvents(session.id)).filter(
          (e) => e.type === 'transcript' && e.payload.itemId === 'reply-1',
        );
        expect(transcripts).toHaveLength(1);
        expect(transcripts[0].payload.text).toBe('Checking password=[REDACTED]');
        expect(wire.events.some((e) => e.type === 'audio' && e.sampleRate === 24000)).toBe(true);
        expect(wire.events.some((e) => e.type === 'toolCall')).toBe(false);
      } finally {
        await wire.stop();
      }
    });

    it('cancels a queued mutation before execution without returning a fabricated provider result', async () => {
      const session = await start();
      const wire = await connected(session);
      const gate = deferred();
      const entered = deferred();
      search.mockImplementationOnce(async () => {
        entered.release();
        await gate.promise;
        return [];
      });
      try {
        wire.provider.emit({
          type: 'toolCall',
          id: 'slow-search',
          name: 'search_knowledge_base',
          input: { query: 'UK 403' },
        });
        await entered.promise;
        wire.provider.emit({
          type: 'toolCall',
          id: 'cancel-ticket',
          name: 'create_support_ticket',
          input: { subject: 'Do not create', description: 'Canceled before execution', severity: 'low' },
        });
        wire.provider.emit({ type: 'toolCancelled', ids: ['cancel-ticket'] });
        wire.provider.emit({ type: 'metric', name: 'after-cancel', value: 1, unit: 'count' });
        gate.release();
        await eventually(
          () => repo.getEvents(session.id),
          (events) => events.some((e) => e.type === 'voice.metric' && e.payload.name === 'after-cancel'),
          'queue drain',
        );
        expect(await repo.getTickets(session.id)).toHaveLength(0);
        expect(vi.mocked(wire.provider.session.sendToolResult).mock.calls.map((args) => args[0].id)).toEqual([
          'slow-search',
        ]);
      } finally {
        gate.release();
        await wire.stop();
      }
    });

    it('blocks end during voice and releases voiceActive only after in-flight work drains', async () => {
      const session = await start();
      const wire = await connected(session);
      const gate = deferred();
      const entered = deferred();
      search.mockImplementationOnce(async () => {
        entered.release();
        await gate.promise;
        return [];
      });
      try {
        wire.provider.emit({
          type: 'toolCall',
          id: 'draining-search',
          name: 'search_knowledge_base',
          input: { query: 'UK incident' },
        });
        await entered.promise;
        wire.send({ type: 'stop' });
        await eventually(
          () => wire.provider.closed,
          (value) => value,
          'provider close',
        );
        expect(app.voiceActive.has(session.id)).toBe(true);
        expect((await end(session)).status).toBe(409);
        gate.release();
        await wire.closed;
        await eventually(
          () => app.voiceActive.has(session.id),
          (value) => !value,
          'voice drain',
        );
        expect(wire.provider.session.sendToolResult).not.toHaveBeenCalled();
        expect((await end(session)).status).toBe(200);
      } finally {
        gate.release();
        await wire.stop();
      }
    });

    it('releases a disconnected socket and allows support end without an explicit stop message', async () => {
      const session = await start();
      const wire = await connected(session);
      wire.ws.terminate();
      await wire.closed;
      await eventually(
        () => app.voiceActive.has(session.id),
        (value) => !value,
        'disconnect cleanup',
      );
      expect(wire.provider.session.close).toHaveBeenCalledOnce();
      expect((await end(session)).status).toBe(200);
    });

    it('requests missing knowledge/outcome tools after investigation and caps workflow reminders at two', async () => {
      const session = await start();
      const wire = await connected(session);
      try {
        wire.provider.emit({ type: 'turn', phase: 'completed' });
        wire.provider.emit({ type: 'metric', name: 'greeting-done', value: 1, unit: 'count' });
        await eventually(
          () => repo.getEvents(session.id),
          (events) => events.some((e) => e.type === 'voice.metric' && e.payload.name === 'greeting-done'),
          'greeting queue drain',
        );
        expect(
          vi
            .mocked(wire.provider.session.sendText)
            .mock.calls.filter((args) => args[0].includes('Application workflow check')),
        ).toHaveLength(0);
        wire.provider.emit({
          type: 'toolCall',
          id: 'investigated-calls',
          name: 'get_recent_calls',
          input: { limit: 5 },
        });
        await eventually(
          () => vi.mocked(wire.provider.session.sendToolResult).mock.calls,
          (calls) => calls.length === 1,
          'operational tool execution',
        );
        for (let i = 0; i < 4; i++) wire.provider.emit({ type: 'turn', phase: 'completed' });
        wire.provider.emit({ type: 'metric', name: 'reminder-check-complete', value: 1, unit: 'count' });
        const persisted = await eventually(
          () => repo.getEvents(session.id),
          (events) =>
            events.some((e) => e.type === 'voice.metric' && e.payload.name === 'reminder-check-complete'),
          'reminder queue drain',
        );
        const reminders = vi
          .mocked(wire.provider.session.sendText)
          .mock.calls.filter((args) => args[0].includes('Application workflow check'));
        expect(reminders).toHaveLength(2);
        for (const [text] of reminders) {
          expect(text).toContain('search_knowledge_base');
          expect(text).toContain('complete_support_case');
        }
        expect(
          persisted.filter((e) => e.type === 'support.state' && e.payload.state === 'checking-completeness'),
        ).toHaveLength(2);
      } finally {
        await wire.stop();
      }
    });

    it('closes a provider that finishes connecting after the browser already disconnected', async () => {
      const session = await start();
      const pending = new FakeProvider();
      pending.gate = deferred();
      nextFake = pending;
      const wire = socket(session);
      await wire.opened;
      wire.send({ type: 'start', provider: 'gemini' });
      await eventually(
        () => pending.config,
        (config) => !!config,
        'provider connect entry',
      );
      wire.ws.terminate();
      await wire.closed;
      await eventually(
        () => app.voiceActive.has(session.id),
        (value) => !value,
        'startup disconnect cleanup',
      );
      pending.gate.release();
      await eventually(
        () => pending.closed,
        (value) => value,
        'late provider close',
      );
      expect(pending.session.sendText).not.toHaveBeenCalled();
      expect((await end(session)).status).toBe(200);
    });
  },
);
