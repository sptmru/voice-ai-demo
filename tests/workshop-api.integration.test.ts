import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../apps/api/src/app.js';
import { PostgresRepository } from '../packages/db/src/index.js';
import { migrate } from '../packages/db/src/migrate.js';
import { seedOperationalData } from '../scripts/seed.js';
import type { RetrievalService } from '../packages/core/src/domain.js';
vi.mock('../packages/core/src/photo.js', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  extractRepairPhoto: vi.fn(async () => ({
    model: 'W100',
    appliance: 'washing-machine',
    errorCode: 'E21',
    uncertainties: ['Check the model label.'],
  })),
}));
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('workshop HTTP ownership, review and approval boundaries', () => {
  const schema = `relay_workshop_api_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const database = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  const repo = new PostgresRepository(database);
  const rag: RetrievalService = {
    search: async () => [],
    ingest: async () => {
      throw Error('unused');
    },
    listDocuments: async () => [],
    deleteDocument: async () => false,
  };
  let server: Server;
  let base: string;
  beforeAll(async () => {
    await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(database);
    await seedOperationalData(database);
    const api = createApp(repo, rag, database);
    api.app.use(api.errorHandler);
    server = await new Promise<Server>((resolve) => {
      const instance = api.app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await database.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  async function request(path: string, cookie?: string, body?: unknown) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { response, data: (await response.json()) as any };
  }
  async function start(cookie?: string) {
    const r = await request('/api/sessions', cookie, { scenarioId: 'repair-advice', mode: 'rehearsal' });
    expect(r.response.status).toBe(201);
    return { id: r.data.session.id, cookie: cookie ?? r.response.headers.get('set-cookie')!.split(';')[0] };
  }
  it('defaults to rehearsal and rejects live with no configured calendar', async () => {
    const r = await request('/api/sessions', undefined, { scenarioId: 'repair-booking' });
    expect(r.data.session.mode).toBe('rehearsal');
    const live = await request('/api/sessions', undefined, { scenarioId: 'repair-booking', mode: 'live' });
    expect(live.response.status).toBe(409);
    const ready = await request('/api/readiness');
    expect(ready.data.calendar.configured).toBe(false);
    expect(ready.data.text.provider).toBe('deterministic');
    expect(ready.data.vision.configured).toBe(false);
  });
  it('only applies owner-reviewed photo fields, once, and retains no image bytes', async () => {
    const own = await start(),
      stranger = await start();
    const data = new FormData();
    data.set('image', new Blob(['fixture']), 'label.png');
    const upload = await fetch(`${base}/api/sessions/${own.id}/photos`, {
      method: 'POST',
      headers: { Cookie: own.cookie },
      body: data,
    });
    expect(upload.status).toBe(201);
    const photo = (await upload.json()) as any;
    expect((await repo.getSession(own.id)).snapshot.repair?.model).toBeUndefined();
    expect(
      (
        await request(`/api/sessions/${own.id}/photos/${photo.id}/confirm`, stranger.cookie, {
          model: 'W100',
        })
      ).response.status,
    ).toBe(404);
    const confirmed = await request(`/api/sessions/${own.id}/photos/${photo.id}/confirm`, own.cookie, {
      model: 'W200',
      appliance: 'washing-machine',
      errorCode: 'E22',
    });
    expect(confirmed.response.status).toBe(200);
    expect(confirmed.data.session.snapshot.repair).toMatchObject({ model: 'W200', issue: 'Error E22' });
    expect(
      (await request(`/api/sessions/${own.id}/photos/${photo.id}/confirm`, own.cookie, { model: 'W100' }))
        .response.status,
    ).toBe(409);
    expect(JSON.stringify(await repo.getEvents(own.id))).not.toContain('data:image');
  });
  it('adds photo error codes without losing the same-appliance symptom and accepts the full reviewed text limit', async () => {
    const own = await start();
    const session = await repo.getSession(own.id);
    await repo.updateSession(own.id, {
      snapshot: {
        ...session.snapshot,
        repair: {
          ...session.snapshot.repair!,
          appliance: 'washing-machine',
          model: 'W100',
          issue: 'Will not drain after the wash cycle',
        },
      },
    });
    const review = async (fields: unknown) => {
      const data = new FormData();
      data.set('image', new Blob(['fixture']), 'label.png');
      const upload = await fetch(`${base}/api/sessions/${own.id}/photos`, {
        method: 'POST',
        headers: { Cookie: own.cookie },
        body: data,
      });
      const photo = (await upload.json()) as any;
      return request(`/api/sessions/${own.id}/photos/${photo.id}/confirm`, own.cookie, fields);
    };
    const merged = await review({ model: 'Relay Wash W100', errorCode: 'E21' });
    expect(merged.response.status).toBe(200);
    expect(merged.data.session.snapshot.repair.issue).toBe('Will not drain after the wash cycle; Error E21');
    const full = await review({ issue: 'x'.repeat(500), errorCode: 'E21' });
    expect(full.response.status).toBe(200);
    expect(full.data.session.snapshot.repair.issue).toBe('x'.repeat(500) + '; Error E21');
    const changed = await review({ model: 'W200', errorCode: 'E22' });
    expect(changed.data.session.snapshot.repair.issue).toBe('Error E22');
  });
  it('shows jobs only to their owner and permits quote approval during operator handoff without resuming AI', async () => {
    const own = await start(),
      stranger = await start();
    expect((await request(`/api/sessions/${own.id}/repair-jobs`, stranger.cookie)).response.status).toBe(404);
    await request(`/api/sessions/${own.id}/handoff`, own.cookie, { reason: 'Review my repair quote' });
    await request(`/api/sessions/${own.id}/handoff/accept`, own.cookie, {});
    const proposal = await request(`/api/sessions/${own.id}/repair-jobs/REP-1042/approve`, own.cookie, {});
    expect(proposal.data.status).toBe('pending-confirmation');
    expect((await repo.getRepairJob(own.id, 'REP-1042'))?.status).toBe('awaiting_approval');
    const confirmed = await request(
      `/api/sessions/${own.id}/confirmations/${proposal.data.confirmationId}`,
      own.cookie,
      { approve: true },
    );
    expect(confirmed.data.status).toBe('completed');
    expect((await repo.getRepairJob(own.id, 'REP-1042'))?.status).toBe('in_progress');
    expect((await repo.getSession(own.id)).handoff?.status).toBe('accepted');
    expect(
      (await request(`/api/sessions/${own.id}/messages`, own.cookie, { text: 'Are you there?' })).data.text,
    ).toBe('');
  });
});
