import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresRepository } from '../packages/db/src/index.js';
import { migrate } from '../packages/db/src/migrate.js';
import { seedKnowledge, seedOperationalData } from '../scripts/seed.js';
import { RagService, embed } from '../packages/rag/src/index.js';
import { SupportRuntime } from '../packages/core/src/runtime.js';

// This suite creates/drops only its own random schema. It never truncates the demo or production tables.
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('PostgreSQL persistence and actual local multilingual hybrid retrieval', () => {
  const schema = `relay_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const database = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  const repo = new PostgresRepository(database);
  const rag = new RagService(database);

  beforeAll(async () => {
    await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(database);
    await seedOperationalData(database);
    await seedKnowledge(database);
  });
  afterAll(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('creates isolated snapshots and keeps deterministic templates unchanged', async () => {
    const one = await repo.createSession('invalid-credentials');
    const two = await repo.createSession('invalid-credentials');
    await repo.createAction(
      one.id,
      'credential-reset',
      { reason: 'Customer approved', mode: 'simulated', credentialVersion: 999 },
      'reset-one',
    );
    expect((await repo.getSession(one.id)).snapshot.trunk).toMatchObject({
      credentialsValid: true,
      credentialVersion: 2,
      registered: false,
    });
    expect((await repo.getSession(two.id)).snapshot.trunk).toMatchObject({
      credentialsValid: false,
      credentialVersion: 1,
    });
    expect((await repo.createSession('invalid-credentials')).snapshot.trunk.credentialsValid).toBe(false);
  });

  it('persists events, replay cursors, tickets and action idempotency across repository instances', async () => {
    const session = await repo.createSession('carrier-incident');
    const first = await repo.appendEvent(session.id, 'support.state', { state: 'checking' });
    const second = await repo.appendEvent(session.id, 'support.state', { state: 'diagnosed' });
    const ticket = await repo.createTicket(session.id, {
      subject: 'UK SIP 403',
      description: 'INC-UK-20260915',
      severity: 'high',
    });
    const fresh = new PostgresRepository(database);
    expect(await fresh.getEvents(session.id, first.id)).toEqual([second]);
    expect(await fresh.getTickets(session.id)).toEqual([ticket]);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => repo.createAction(session.id, 'callback', { at: 'later' }, 'same-key')),
    );
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    await expect(repo.createAction(session.id, 'callback', { at: 'different' }, 'same-key')).rejects.toThrow(
      'different action',
    );
  });

  it('claims confirmations once, rejects foreign sessions and expires old tokens', async () => {
    const session = await repo.createSession('invalid-credentials');
    const other = await repo.createSession('invalid-credentials');
    const pending = await repo.createConfirmation(session.id, 'reset_credentials', { reason: 'Rotate' });
    await expect(repo.resolveConfirmation(other.id, pending.id, true)).rejects.toThrow('unavailable');
    const raced = await Promise.allSettled([
      repo.resolveConfirmation(session.id, pending.id, true),
      repo.resolveConfirmation(session.id, pending.id, true),
    ]);
    expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const expired = await repo.createConfirmation(session.id, 'reset_credentials', {});
    await database.query(
      "UPDATE pending_confirmations SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [expired.id],
    );
    await expect(repo.resolveConfirmation(session.id, expired.id, true)).rejects.toThrow('expired');
    expect((await repo.getConfirmations(session.id)).find((item) => item.id === expired.id)?.status).toBe(
      'expired',
    );
  });

  it('stores a reset action and mutates the snapshot atomically and exactly once', async () => {
    const session = await repo.createSession('invalid-credentials');
    await Promise.all(
      Array.from({ length: 5 }, () =>
        repo.createAction(
          session.id,
          'credential-reset',
          { reason: 'Rotate', mode: 'simulated' },
          'one-reset',
        ),
      ),
    );
    expect((await repo.getSession(session.id)).snapshot.trunk.credentialVersion).toBe(2);
    expect(await repo.getActions(session.id)).toHaveLength(1);
  });

  it('redacts persisted free text, transcripts and memory while preserving opaque correlation IDs', async () => {
    const runtime = new SupportRuntime(repo, rag);
    const session = await runtime.startSession('invalid-credentials');
    const secret = 'password=db-sensitive-sentinel';
    await repo.appendEvent(
      session.id,
      'transcript',
      { role: 'user', text: secret },
      undefined,
      'sk-opaque-provider-id-12345',
    );
    await repo.saveMemory(session.customerId, 'fact', `User accidentally wrote ${secret}`, session.id);
    await runtime.executeTool(session.id, {
      id: 'secret-ticket',
      name: 'create_support_ticket',
      input: { subject: 'Auth', description: secret, severity: 'high' },
    });
    await runtime.executeTool(session.id, {
      id: 'secret-followup',
      name: 'send_followup',
      input: { message: secret },
    });
    const pending = await runtime.executeTool(session.id, {
      id: 'secret-reset',
      name: 'reset_trunk_credentials',
      input: { reason: secret },
    });
    await runtime.confirm(session.id, pending.confirmationId!, true);
    await runtime.executeTool(session.id, {
      id: 'secret-outcome',
      name: 'complete_support_case',
      input: {
        intent: 'technical_support',
        severity: 'high',
        product: 'SIP',
        issue: 'Authentication',
        diagnosis: secret,
        resolved: false,
        nextAction: 'Verify recovery',
      },
    });
    await runtime.endSession(session.id);
    const records = await Promise.all([
      repo.getSession(session.id),
      repo.getEvents(session.id),
      repo.getTickets(session.id),
      repo.getActions(session.id),
      repo.getConfirmations(session.id),
      repo.getMemory(session.customerId),
    ]);
    expect(JSON.stringify(records)).not.toContain('db-sensitive-sentinel');
    expect(
      (await repo.getEvents(session.id)).some(
        (event) => event.correlationId === 'sk-opaque-provider-id-12345',
      ),
    ).toBe(true);
    const raw = await database.query('SELECT input FROM support_actions WHERE session_id=$1', [session.id]);
    expect(JSON.stringify(raw.rows)).not.toContain('db-sensitive-sentinel');
  });

  it('includes late actions in the finalized outcome and produces a partial report when the model omits it', async () => {
    const runtime = new SupportRuntime(repo, rag);
    const session = await runtime.startSession('invalid-credentials');
    await runtime.executeTool(session.id, {
      id: 'early-outcome',
      name: 'complete_support_case',
      input: {
        intent: 'technical_support',
        severity: 'high',
        product: 'SIP',
        issue: 'Authentication',
        diagnosis: 'Credentials are invalid',
        resolved: false,
        nextAction: 'Request approved reset',
      },
    });
    const pending = await runtime.executeTool(session.id, {
      id: 'late-reset',
      name: 'reset_trunk_credentials',
      input: { reason: 'Rotate' },
    });
    await runtime.confirm(session.id, pending.confirmationId!, true);
    const ended = await runtime.endSession(session.id);
    const actions = await repo.getActions(session.id);
    expect(ended.outcome?.actions).toContain(`credential-reset:${actions[0].id}`);
    expect(ended.outcome?.actions).toContain('tool:reset_trunk_credentials');
    const partial = await runtime.startSession('carrier-incident');
    await runtime.executeTool(partial.id, { id: 'partial-account', name: 'get_account', input: {} });
    const report = await runtime.endSession(partial.id);
    expect(report.outcome).toMatchObject({ resolved: false, issue: 'Incomplete support investigation' });
    expect(report.outcome?.diagnosis).not.toContain('carrier degradation');
    expect(report.outcome?.nextAction).toContain('human engineer');
  });

  it('applies allowed session IDs before the history limit', async () => {
    const own = await repo.createSession('carrier-incident');
    await database.query("UPDATE support_sessions SET created_at=now()-interval '1 day' WHERE id=$1", [
      own.id,
    ]);
    await database.query(`INSERT INTO support_sessions(id,customer_id,scenario_id,snapshot)
      SELECT gen_random_uuid(),customer_id,id,snapshot FROM scenario_templates CROSS JOIN generate_series(1,101) WHERE id='carrier-incident'`);
    expect((await repo.listSessions()).some((session) => session.id === own.id)).toBe(false);
    expect((await repo.listSessions([own.id])).map((session) => session.id)).toEqual([own.id]);
    expect(await repo.listSessions([])).toEqual([]);
  });

  it('selectively retrieves relevant case memory and checks customer ownership', async () => {
    const session = await repo.createSession('carrier-incident');
    await repo.saveMemory(session.customerId, 'case', 'UK carrier degradation with SIP 403', session.id);
    await repo.saveMemory(session.customerId, 'case', 'Invoice receipt request', session.id);
    await repo.saveMemory(session.customerId, 'preference', 'Prefers email updates', session.id);
    const memory = await repo.getMemory(session.customerId, 'carrier');
    expect(memory.map((item) => item.content)).toContain('UK carrier degradation with SIP 403');
    expect(memory.map((item) => item.content)).toContain('Prefers email updates');
    expect(memory.map((item) => item.content)).not.toContain('Invoice receipt request');
    await expect(repo.saveMemory('someone-else', 'case', 'Wrong customer', session.id)).rejects.toThrow(
      'does not own',
    );
  });

  it('matches natural history questions and balances memory kinds without unrelated old cases', async () => {
    const session = await repo.createSession('carrier-incident');
    await repo.saveMemory(
      session.customerId,
      'case',
      'UK SIP 403 affected outbound calling through carrier A.',
      session.id,
    );
    await repo.saveMemory(
      session.customerId,
      'summary',
      'UK carrier rejection was linked to INC-UK-20260915; waiting for recovery.',
      session.id,
    );
    await repo.saveMemory(
      session.customerId,
      'case',
      'An old invoice-address correction was completed.',
      session.id,
    );
    for (let index = 0; index < 10; index++)
      await repo.saveMemory(session.customerId, 'fact', `Customer profile fact ${index}`, session.id);
    const memory = await repo.getMemory(session.customerId, 'What happened in our previous UK case?');
    expect(memory.some((item) => item.kind === 'case' && item.content.includes('UK SIP 403'))).toBe(true);
    expect(
      memory.some((item) => item.kind === 'summary' && item.content.includes('UK carrier rejection')),
    ).toBe(true);
    expect(memory.some((item) => item.content.includes('invoice-address'))).toBe(false);
    for (const kind of ['fact', 'preference', 'case', 'summary'])
      expect(memory.filter((item) => item.kind === kind).length).toBeLessThanOrEqual(2);
    expect(memory.slice(0, 5).some((item) => item.kind === 'case')).toBe(true);
    expect(memory.slice(0, 5).some((item) => item.kind === 'summary')).toBe(true);
    expect(
      (await repo.getMemory(session.customerId, 'Show my previous cases')).some(
        (item) => item.kind === 'case',
      ),
    ).toBe(true);
  });

  it('produces real normalized 384-dimensional embeddings and ranks carrier documentation', async () => {
    const vector = await embed('UK calls rejected with SIP 403');
    expect(vector).toHaveLength(384);
    expect(Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 4);
    const result = await rag.search('UK outbound SIP 403 carrier degradation', 5);
    expect(result.some((chunk) => chunk.document === 'UK calling guide and carrier rejection checks')).toBe(
      true,
    );
    expect(result[0].semanticScore).toBeGreaterThan(0);
    expect(result[0].lexicalScore).toBeGreaterThan(0);
    expect(result[0].combinedScore).toBeGreaterThan(0);
    expect(result.every((chunk) => chunk.chunkId && chunk.section && chunk.source && chunk.type)).toBe(true);
  });

  it('idempotently indexes seed sources and makes uploaded facts immediately searchable', async () => {
    expect(await rag.listDocuments()).toHaveLength(27);
    await seedKnowledge(database);
    expect(await rag.listDocuments()).toHaveLength(27);
    const input = {
      title: 'ZEPHYR-924 maintenance',
      content:
        '# ZEPHYR-924\nThe ZEPHYR-924 support marker identifies the fictional Bristol trunk maintenance window. Tell customers that the maintenance completes at 14:20 UTC.',
      source: 'upload:test-zephyr',
      type: 'markdown',
    };
    const doc = await rag.ingest(input);
    expect((await rag.ingest(input)).id).toBe(doc.id);
    const found = await rag.search('ZEPHYR-924', 3);
    expect(found[0].documentId).toBe(doc.id);
    expect(found[0].content).toContain('14:20 UTC');
  });
});
