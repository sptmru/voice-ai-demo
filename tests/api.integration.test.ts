import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../apps/api/src/app.js';
import { PostgresRepository } from '../packages/db/src/index.js';
import { migrate } from '../packages/db/src/migrate.js';
import { RagService } from '../packages/rag/src/index.js';
import { seedKnowledge, seedOperationalData } from '../scripts/seed.js';
import type { AgentEvent, ScenarioId } from '../packages/core/src/domain.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('HTTP API with real PostgreSQL, retrieval and SSE', () => {
  const schema = `relay_api_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const database = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  const repo = new PostgresRepository(database);
  const rag = new RagService(database);
  let api: ReturnType<typeof createApp>;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(database);
    await seedOperationalData(database);
    await seedKnowledge(database);
    api = createApp(repo, rag, database);
    api.app.use(api.errorHandler);
    server = await new Promise<Server>((resolve) => {
      const instance = api.app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await database.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  async function request(
    path: string,
    options: { cookie?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
      headers: {
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    return { response, body: response.status === 204 ? undefined : ((await response.json()) as any) };
  }

  async function start(scenarioId: ScenarioId = 'repair-advice', cookie?: string) {
    const result = await request('/api/sessions', { body: { scenarioId }, cookie });
    expect(result.response.status).toBe(201);
    return {
      id: result.body.session.id as string,
      cookie: cookie ?? result.response.headers.get('set-cookie')!.split(';')[0],
      response: result.response,
    };
  }

  async function subscribe(id: string, cookie: string, after: number, useHeader = false) {
    const abort = new AbortController();
    const response = await fetch(`${base}/api/sessions/${id}/events${useHeader ? '' : `?after=${after}`}`, {
      headers: { Cookie: cookie, ...(useHeader ? { 'Last-Event-ID': String(after) } : {}) },
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    const events: AgentEvent[] = [];
    return {
      async until(predicate: (events: AgentEvent[]) => boolean): Promise<AgentEvent[]> {
        const timer = setTimeout(() => abort.abort(new Error('Timed out waiting for SSE events')), 8000);
        try {
          while (!predicate(events)) {
            const { value, done } = await reader.read();
            if (done) throw new Error('SSE closed before expected event');
            pending += decoder.decode(value, { stream: true });
            let boundary: number;
            while ((boundary = pending.indexOf('\n\n')) >= 0) {
              const frame = pending.slice(0, boundary);
              pending = pending.slice(boundary + 2);
              const data = frame.split('\n').find((line) => line.startsWith('data: '));
              if (data) events.push(JSON.parse(data.slice(6)) as AgentEvent);
            }
          }
          return events;
        } finally {
          clearTimeout(timer);
        }
      },
      async close() {
        await reader.cancel();
        abort.abort();
      },
    };
  }

  it('only advertises supported scenarios and rejects retired scenarios', async () => {
    const config = await request('/api/config');
    expect(config.body.scenarios.some((s: any) => s.id === 'repair-advice')).toBe(true);
    expect(config.body.scenarios.some((s: any) => s.id === 'carrier-incident')).toBe(false);
    expect(
      (await request('/api/sessions', { body: { scenarioId: 'carrier-incident' } })).response.status,
    ).toBe(400);
    expect(api.runtime.executor.tools.some((tool) => tool.name === 'reset_trunk_credentials')).toBe(false);
  });

  it('binds a session to an HttpOnly owner cookie and blocks cross-owner reads and writes', async () => {
    const alice = await start();
    const bob = await start();
    expect(alice.response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(alice.response.headers.get('set-cookie')).toContain('SameSite=Strict');
    const list = await request('/api/sessions', { cookie: alice.cookie });
    expect(list.body.map((session: { id: string }) => session.id)).toContain(alice.id);
    expect(list.body.map((session: { id: string }) => session.id)).not.toContain(bob.id);
    const detail = await request(`/api/sessions/${alice.id}`, { cookie: alice.cookie });
    expect(
      detail.body.memory.some(
        (item: { kind: string; content: string }) =>
          item.kind === 'fact' && item.content.includes('Asia/Yerevan'),
      ),
    ).toBe(true);
    expect(
      detail.body.memory.some(
        (item: { kind: string; content: string }) =>
          item.kind === 'preference' && item.content.includes('email'),
      ),
    ).toBe(true);
    expect((await request(`/api/sessions/${alice.id}`, { cookie: bob.cookie })).response.status).toBe(404);
    expect(
      (
        await request(`/api/sessions/${alice.id}/messages`, {
          cookie: bob.cookie,
          body: { text: 'Investigate' },
        })
      ).response.status,
    ).toBe(404);
    expect(
      (await request(`/api/sessions/${alice.id}/end`, { cookie: bob.cookie, body: {} })).response.status,
    ).toBe(404);
    expect((await request(`/api/sessions/${alice.id}/events`, { cookie: bob.cookie })).response.status).toBe(
      404,
    );
    expect((await repo.getSession(alice.id)).status).toBe('active');
  });

  it('persists an owner-scoped operator handoff and stops AI after transfer', async () => {
    const alice = await start();
    const bob = await start();
    const path = `/api/sessions/${alice.id}`;
    expect(
      (await request(`${path}/handoff`, { cookie: bob.cookie, body: { reason: 'Help' } })).response.status,
    ).toBe(404);
    expect(
      (await request(`${path}/operator/messages`, { cookie: alice.cookie, body: { text: 'Hello' } })).response
        .status,
    ).toBe(409);
    const transfer = await request(`${path}/handoff`, {
      cookie: alice.cookie,
      body: { reason: 'Please connect a person' },
    });
    expect(transfer.body.handoff).toMatchObject({ status: 'waiting', reason: 'Please connect a person' });
    expect(transfer.body.handoff.summary).toContain('Workshop customer');
    const same = await request(`${path}/handoff`, {
      cookie: alice.cookie,
      body: { reason: 'Please connect a person' },
    });
    expect(same.body.handoff).toEqual(transfer.body.handoff);
    const queue = await request('/api/operator/queue', { cookie: alice.cookie });
    expect(queue.body.map((row: any) => row.session.id)).toContain(alice.id);
    const foreignQueue = await request('/api/operator/queue', { cookie: bob.cookie });
    expect(foreignQueue.body.map((row: any) => row.session.id)).not.toContain(alice.id);
    expect((await request(`${path}/handoff/accept`, { cookie: bob.cookie, body: {} })).response.status).toBe(
      404,
    );
    const accepted = await request(`${path}/handoff/accept`, { cookie: alice.cookie, body: {} });
    expect(accepted.body.handoff.status).toBe('accepted');
    const repeated = await request(`${path}/handoff/accept`, { cookie: alice.cookie, body: {} });
    expect(repeated.body.handoff.acceptedAt).toBe(accepted.body.handoff.acceptedAt);
    const before = await repo.getEvents(alice.id);
    const userMessage = await request(`${path}/messages`, {
      cookie: alice.cookie,
      body: { text: 'I still need help' },
    });
    expect(userMessage.response.status).toBe(200);
    const reply = await request(`${path}/operator/messages`, {
      cookie: alice.cookie,
      body: { text: 'I am reviewing your request' },
    });
    expect(reply.body.event.payload).toMatchObject({ role: 'operator', mode: 'human' });
    const after = (await repo.getEvents(alice.id)).filter((event) => event.id > (before.at(-1)?.id ?? 0));
    expect(after.filter((event) => event.type === 'transcript').map((event) => event.payload.role)).toEqual([
      'user',
      'operator',
    ]);
    expect(after.some((event) => event.type === 'tool.started')).toBe(false);
    const tool = await api.runtime.executeTool(alice.id, {
      id: 'blocked-after-handoff',
      name: 'create_support_ticket',
      input: { subject: 'No', description: 'No', severity: 'low' },
    });
    expect(tool.status).toBe('failed');
    expect(await repo.getTickets(alice.id)).toHaveLength(0);
    const persisted = await new PostgresRepository(database).getSession(alice.id);
    expect(persisted.handoff?.status).toBe('accepted');
    await request(`${path}/end`, { cookie: alice.cookie, body: {} });
    expect(
      (await request(`${path}/operator/messages`, { cookie: alice.cookie, body: { text: 'Late reply' } }))
        .response.status,
    ).toBe(409);
    expect((await request('/api/operator/queue', { cookie: alice.cookie })).body).toEqual([]);
  });

  it('rejects a hostile browser Origin before creating any session', async () => {
    const before = Number((await database.query('SELECT count(*) FROM support_sessions')).rows[0].count);
    const result = await request('/api/sessions', {
      body: { scenarioId: 'repair-advice' },
      headers: { Origin: 'https://hostile.example' },
    });
    expect(result.response.status).toBe(403);
    expect(result.body.error).toBe('Origin not allowed');
    expect(result.response.headers.get('access-control-allow-origin')).toBeNull();
    expect(Number((await database.query('SELECT count(*) FROM support_sessions')).rows[0].count)).toBe(
      before,
    );
  });

  it('deletes only an owned session and atomically removes its records and derived memory', async () => {
    const session = await start();
    const other = await start();
    const customerId = (await repo.getSession(session.id)).customerId;
    await repo.createTicket(session.id, {
      subject: 'Delete fixture',
      description: 'Local test',
      severity: 'low',
    });
    await repo.createAction(session.id, 'callback', { at: 'later' }, 'delete-fixture');
    await repo.createConfirmation(session.id, 'approve_repair_quote', { reason: 'Local test' });
    await repo.saveMemory(customerId, 'summary', `Deletion summary ${session.id}`, session.id);
    await repo.saveMemory(customerId, 'case', `Deletion case ${session.id}`, session.id);
    await repo.saveMemory(customerId, 'summary', `Retained summary ${other.id}`, other.id);
    const factsBefore = (
      await database.query('SELECT id FROM customer_memory WHERE source_session_id IS NULL ORDER BY id')
    ).rows;
    expect(
      (await request(`/api/sessions/${session.id}`, { method: 'DELETE', cookie: other.cookie })).response
        .status,
    ).toBe(404);
    expect(
      (await request(`/api/sessions/${randomUUID()}`, { method: 'DELETE', cookie: session.cookie })).response
        .status,
    ).toBe(404);
    expect(
      (await request('/api/sessions/not-a-uuid', { method: 'DELETE', cookie: session.cookie })).response
        .status,
    ).toBe(400);
    expect(
      (await request(`/api/sessions/${session.id}`, { method: 'DELETE', cookie: session.cookie })).response
        .status,
    ).toBe(204);
    for (const table of [
      'agent_events',
      'support_tickets',
      'support_actions',
      'pending_confirmations',
      'api_session_owners',
    ]) {
      expect(
        (await database.query(`SELECT count(*)::int AS n FROM ${table} WHERE session_id=$1`, [session.id]))
          .rows[0].n,
      ).toBe(0);
    }
    expect(
      (
        await database.query('SELECT count(*)::int AS n FROM customer_memory WHERE source_session_id=$1', [
          session.id,
        ])
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await database.query('SELECT count(*)::int AS n FROM customer_memory WHERE content LIKE $1', [
          `%${session.id}%`,
        ])
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await database.query('SELECT id FROM customer_memory WHERE source_session_id IS NULL ORDER BY id'))
        .rows,
    ).toEqual(factsBefore);
    expect((await repo.getSession(other.id)).status).toBe('active');
    expect(
      (await database.query('SELECT id FROM customer_memory WHERE source_session_id=$1', [other.id]))
        .rowCount,
    ).toBe(1);
    expect((await request('/api/sessions', { cookie: session.cookie })).body).toEqual([]);
    expect((await request(`/api/sessions/${session.id}`, { cookie: session.cookie })).response.status).toBe(
      404,
    );
    expect(
      (await request(`/api/sessions/${session.id}`, { method: 'DELETE', cookie: session.cookie })).response
        .status,
    ).toBe(404);
  });

  it('closes a deleted session SSE stream and refuses new subscriptions', async () => {
    const session = await start();
    const abort = new AbortController();
    const response = await fetch(`${base}/api/sessions/${session.id}/events`, {
      headers: { Cookie: session.cookie },
      signal: abort.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    try {
      expect(
        (await request(`/api/sessions/${session.id}`, { method: 'DELETE', cookie: session.cookie })).response
          .status,
      ).toBe(204);
      const timeout = setTimeout(() => abort.abort(), 3000);
      try {
        let done = false;
        while (!done) done = (await reader.read()).done;
        expect(done).toBe(true);
      } finally {
        clearTimeout(timeout);
      }
      expect(
        (await request(`/api/sessions/${session.id}/events`, { cookie: session.cookie })).response.status,
      ).toBe(404);
    } finally {
      abort.abort();
    }
  });

  it('rejects deletion while busy or voice-connected and blocks mutations during deletion', async () => {
    const session = await start();
    let release!: () => void;
    const operation = api.lock(
      session.id,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    try {
      expect(
        (await request(`/api/sessions/${session.id}`, { method: 'DELETE', cookie: session.cookie })).response
          .status,
      ).toBe(409);
    } finally {
      release();
      await operation;
    }
    api.voiceActive.add(session.id);
    try {
      expect(
        (await request(`/api/sessions/${session.id}`, { method: 'DELETE', cookie: session.cookie })).response
          .status,
      ).toBe(409);
    } finally {
      api.voiceActive.delete(session.id);
    }
    const originalDelete = repo.deleteSession.bind(repo);
    let deleting!: () => void;
    const entered = new Promise<void>((resolve) => {
      deleting = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    repo.deleteSession = async (id) => {
      deleting();
      await gate;
      return originalDelete(id);
    };
    const deletion = request(`/api/sessions/${session.id}`, { method: 'DELETE', cookie: session.cookie });
    try {
      await entered;
      expect(
        (
          await request(`/api/sessions/${session.id}/messages`, {
            cookie: session.cookie,
            body: { text: 'Investigate' },
          })
        ).response.status,
      ).toBe(409);
    } finally {
      release();
      repo.deleteSession = originalDelete;
    }
    expect((await deletion).response.status).toBe(204);
  });

  it('closes an SSE subscription even when deletion races its initial replay', async () => {
    const session = await start();
    const originalGet = repo.getEvents.bind(repo);
    let release!: () => void;
    let reading!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      reading = resolve;
    });
    repo.getEvents = async (id, after) => {
      const events = await originalGet(id, after);
      if (id === session.id) {
        reading();
        await gate;
      }
      return events;
    };
    const abort = new AbortController();
    try {
      const response = await fetch(`${base}/api/sessions/${session.id}/events`, {
        headers: { Cookie: session.cookie },
        signal: abort.signal,
      });
      await entered;
      expect(
        (await request(`/api/sessions/${session.id}`, { method: 'DELETE', cookie: session.cookie })).response
          .status,
      ).toBe(204);
      release();
      const timeout = setTimeout(() => abort.abort(), 3000);
      try {
        expect((await response.body!.getReader().read()).done).toBe(true);
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      release();
      repo.getEvents = originalGet;
      abort.abort();
    }
  });

  it('streams actual diagnostic tool/retrieval/outcome events and replays only events after a cursor', async () => {
    const session = await start();
    const live = await subscribe(session.id, session.cookie, 0);
    try {
      const initial = await live.until((events) => events.some((event) => event.type === 'support.state'));
      expect(initial.some((event) => event.type === 'customer.identified')).toBe(true);
      const result = await request(`/api/sessions/${session.id}/messages`, {
        cookie: session.cookie,
        body: { text: 'My Relay Wash W100 washing machine will not drain and shows E21. What should I do?' },
      });
      expect(result.response.status).toBe(200);
      expect(result.body.text).toBeTruthy();
      const events = await live.until((items) =>
        items.some((event) => event.type === 'transcript' && event.payload.role === 'assistant'),
      );
      expect(
        events.some(
          (event) => event.type === 'tool.completed' && event.payload.name === 'search_knowledge_base',
        ),
      ).toBe(true);
      const retrieval = events.find((event) => event.type === 'retrieval.completed')!;
      expect((retrieval.payload.chunks as unknown[]).length).toBeGreaterThan(0);
      const persisted = await repo.getEvents(session.id);
      expect(events.map((event) => event.id)).toEqual(persisted.map((event) => event.id));
      expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
      const cursor = events.at(-4)!.id;
      const replay = await subscribe(session.id, session.cookie, cursor, true);
      try {
        expect((await replay.until((items) => items.length === 3)).map((event) => event.id)).toEqual(
          events.filter((event) => event.id > cursor).map((event) => event.id),
        );
      } finally {
        await replay.close();
      }
    } finally {
      await live.close();
    }
  });

  it('does not lose or duplicate events published while the initial replay query is in flight', async () => {
    const session = await start();
    const originalGetEvents = repo.getEvents.bind(repo);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    repo.getEvents = async (id, after) => {
      const replay = await originalGetEvents(id, after);
      if (id === session.id) {
        entered();
        await gate;
      }
      return replay;
    };
    const live = await subscribe(session.id, session.cookie, 0);
    try {
      await reading;
      const concurrent = await api.stream.emitForSession(session.id)(
        'support.state',
        { state: 'during-replay' },
        undefined,
        'opaque-replay-marker',
      );
      release();
      const received = await live.until((events) => events.some((event) => event.id === concurrent.id));
      expect(received.map((event) => event.id)).toEqual(
        (await originalGetEvents(session.id)).map((event) => event.id),
      );
      expect(received.filter((event) => event.id === concurrent.id)).toHaveLength(1);
    } finally {
      release();
      repo.getEvents = originalGetEvents;
      await live.close();
    }
  });

  it('persists opaque provider call IDs and confirmation-prefixed IDs and approves the repair once', async () => {
    const session = await start('repair-status');
    const other = await start('repair-status', session.cookie);
    const call = {
      id: 'provider-function-call_opaque:1',
      name: 'approve_repair_quote',
      input: { jobId: 'REP-1042', expectedRevision: 1, expectedEstimateAMD: 20000 },
    };
    const proposed = await api.runtime.executeTool(session.id, call);
    expect(proposed.status).toBe('pending-confirmation');
    expect((await repo.getRepairJob(session.id, 'REP-1042'))?.status).toBe('awaiting_approval');
    const foreign = await request(`/api/sessions/${other.id}/confirmations/${proposed.confirmationId}`, {
      cookie: session.cookie,
      body: { approve: true },
    });
    expect(foreign.response.status).toBe(404);
    expect((await repo.getConfirmations(session.id))[0].status).toBe('pending');
    const approved = await request(`/api/sessions/${session.id}/confirmations/${proposed.confirmationId}`, {
      cookie: session.cookie,
      body: { approve: true },
    });
    expect(approved.response.status).toBe(200);
    expect(approved.body.status).toBe('completed');
    expect((await repo.getRepairJob(session.id, 'REP-1042'))?.status).toBe('in_progress');
    expect((await repo.getRepairJob(other.id, 'REP-1042'))?.status).toBe('awaiting_approval');
    const persisted = await repo.getEvents(session.id);
    expect(persisted.some((event) => event.correlationId === call.id)).toBe(true);
    expect(
      persisted.some(
        (event) =>
          event.correlationId === `confirmation:${proposed.confirmationId}` &&
          event.type === 'tool.completed',
      ),
    ).toBe(true);
    const duplicate = await request(`/api/sessions/${session.id}/confirmations/${proposed.confirmationId}`, {
      cookie: session.cookie,
      body: { approve: true },
    });
    expect(duplicate.response.status).toBe(409);
    expect(await repo.getActions(session.id)).toHaveLength(1);
  });

  it('retains every persisted event when overlapping publishers finish out of order', async () => {
    const session = await start();
    const live = await subscribe(session.id, session.cookie, 0);
    await live.until((events) => events.some((event) => event.type === 'support.state'));
    const originalAppend = repo.appendEvent.bind(repo);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inserted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    repo.appendEvent = async (...args) => {
      const event = await originalAppend(...args);
      if (args[0] === session.id && args[2].stage === 'delayed-first') {
        entered();
        await gate;
      }
      return event;
    };
    try {
      const emit = api.stream.emitForSession(session.id);
      const first = emit('support.state', { stage: 'delayed-first' });
      await inserted;
      const second = emit('support.state', { stage: 'second' });
      const releaseTimer = setTimeout(release, 50);
      await Promise.all([first, second]);
      clearTimeout(releaseTimer);
      const final = await emit('support.state', { stage: 'final' });
      const received = await live.until((events) => events.some((event) => event.id === final.id));
      expect(received.map((event) => event.id)).toEqual(
        (await repo.getEvents(session.id)).map((event) => event.id),
      );
    } finally {
      release();
      repo.appendEvent = originalAppend;
      await live.close();
    }
  });

  it('rejects expired approval and malformed input with actionable HTTP statuses', async () => {
    const session = await start('repair-status');
    const pending = await repo.createConfirmation(session.id, 'approve_repair_quote', {
      reason: 'Expired test request',
    });
    await database.query(
      "UPDATE pending_confirmations SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [pending.id],
    );
    const expired = await request(`/api/sessions/${session.id}/confirmations/${pending.id}`, {
      cookie: session.cookie,
      body: { approve: true },
    });
    expect(expired.response.status).toBe(410);
    expect(await repo.getActions(session.id)).toHaveLength(0);
    expect(
      (await request(`/api/sessions/${session.id}/messages`, { cookie: session.cookie, body: { text: '' } }))
        .response.status,
    ).toBe(400);
    expect(
      (
        await request(`/api/sessions/${session.id}/messages`, {
          cookie: session.cookie,
          body: { text: 'hello', customerId: 'someone-else' },
        })
      ).response.status,
    ).toBe(400);
    expect((await request('/api/sessions/not-a-uuid', { cookie: session.cookie })).response.status).toBe(400);
    expect(
      (await request(`/api/sessions/${session.id}/events?after=NaN`, { cookie: session.cookie })).response
        .status,
    ).toBe(400);
  });

  it('returns a conflict during an existing operation and refuses messages after session end', async () => {
    const session = await start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = api.lock(session.id, () => gate);
    try {
      expect(
        (
          await request(`/api/sessions/${session.id}/messages`, {
            cookie: session.cookie,
            body: { text: 'Investigate' },
          })
        ).response.status,
      ).toBe(409);
    } finally {
      release();
      await operation;
    }
    expect(
      (await request(`/api/sessions/${session.id}/end`, { cookie: session.cookie, body: {} })).response
        .status,
    ).toBe(200);
    const before = (await repo.getEvents(session.id)).length;
    expect(
      (await request(`/api/sessions/${session.id}/end`, { cookie: session.cookie, body: {} })).response
        .status,
    ).toBe(200);
    expect((await repo.getEvents(session.id)).length).toBe(before);
    expect(
      (
        await request(`/api/sessions/${session.id}/messages`, {
          cookie: session.cookie,
          body: { text: 'Investigate' },
        })
      ).response.status,
    ).toBe(409);
    expect((await repo.getEvents(session.id)).length).toBe(before);
    const ended = await repo.createConfirmation(session.id, 'approve_repair_quote', {
      reason: 'Cannot execute after end',
    });
    expect(
      (
        await request(`/api/sessions/${session.id}/confirmations/${ended.id}`, {
          cookie: session.cookie,
          body: { approve: true },
        })
      ).response.status,
    ).toBe(409);
    expect((await repo.getRepairJob(session.id, 'REP-1042'))?.status).toBe('awaiting_approval');
  });
});
