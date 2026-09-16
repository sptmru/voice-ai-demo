import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresRepository } from '../packages/db/src/index.js';
import { migrate } from '../packages/db/src/migrate.js';
import { seedOperationalData } from '../scripts/seed.js';
import { SupportRuntime } from '../packages/core/src/runtime.js';
import { newToolCall } from '../packages/core/src/executor.js';
import type { RetrievalService, SupportSession } from '../packages/core/src/domain.js';
import { CalendarService, getCalendarService } from '../packages/integrations/src/calendar.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('persistent repair and calendar lifecycle in isolated PostgreSQL', () => {
  const schema = `relay_lifecycle_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const database = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  const repo = new PostgresRepository(database);
  const rag: RetrievalService = {
    search: async () => [],
    ingest: async () => {
      throw Error('Not used');
    },
    listDocuments: async () => [],
    deleteDocument: async () => false,
  };
  const runtime = new SupportRuntime(repo, rag);
  beforeAll(async () => {
    for (const key of [
      'GOOGLE_CALENDAR_ID',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'GOOGLE_REFRESH_TOKEN',
    ])
      expect(process.env[key] ?? '').toBe('');
    await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(database);
    await seedOperationalData(database);
  });
  afterAll(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  const tool = (session: SupportSession, name: string, input: unknown = {}) =>
    runtime.executeTool(session.id, newToolCall(name, input));
  async function session(owner: string = randomUUID()) {
    const created = await runtime.startSession('repair-booking', 'rehearsal');
    await database.query('INSERT INTO api_session_owners(session_id,owner_hash) VALUES($1,$2)', [
      created.id,
      owner,
    ]);
    return created;
  }
  async function book(owner?: string) {
    const created = await session(owner);
    expect(
      (
        await tool(created, 'update_repair_context', {
          appliance: 'washing-machine',
          model: 'W100',
          issue: 'Will not drain',
        })
      ).status,
    ).toBe('completed');
    expect((await tool(created, 'list_available_slots', { serviceId: 'workshop-diagnosis' })).status).toBe(
      'completed',
    );
    const slot = (await repo.getSession(created.id)).snapshot.business!.offeredSlots![0];
    expect(
      (await tool(created, 'book_appointment', { serviceId: 'workshop-diagnosis', ...slot })).status,
    ).toBe('completed');
    return { session: created, appointment: (await repo.getAppointment(created.id))! };
  }
  it('persists an appointment and a new repair across repository instances and scopes access by browser owner', async () => {
    const owner = randomUUID();
    const { session: created, appointment } = await book(owner);
    expect((await repo.getSession(created.id)).mode).toBe('rehearsal');
    expect(appointment).toMatchObject({ provider: 'demo', status: 'booked', revision: 1 });
    const fresh = new PostgresRepository(database);
    expect(await fresh.getAppointment(created.id)).toEqual(appointment);
    const job = (await fresh.listRepairJobs(created.id)).find((j) => j.appointmentId === appointment.id)!;
    expect(job).toMatchObject({
      status: 'scheduled',
      appliance: 'washing-machine',
      model: 'W100',
      revision: 1,
    });
    const sibling = await session(owner),
      stranger = await session();
    expect(await fresh.getRepairJob(sibling.id, job.id)).toEqual(job);
    expect(await fresh.getAppointment(sibling.id, appointment.id)).toEqual(appointment);
    expect(await fresh.getRepairJob(stranger.id, job.id)).toBeNull();
    expect(await fresh.getAppointment(stranger.id, appointment.id)).toBeNull();
  });
  it('requires a review card to move or cancel, updates one event, rejects stale cards and releases the slot', async () => {
    const { session: created, appointment } = await book();
    await tool(created, 'list_available_slots', { serviceId: 'workshop-diagnosis' });
    const slot = (await repo.getSession(created.id)).snapshot.business!.offeredSlots![0];
    const proposal = await tool(created, 'reschedule_appointment', {
      appointmentId: appointment.id,
      expectedRevision: 1,
      ...slot,
    });
    expect(proposal.status).toBe('pending-confirmation');
    expect((await repo.getAppointment(created.id))?.start).toBe(appointment.start);
    expect((await runtime.confirm(created.id, proposal.confirmationId!, true)).status).toBe('completed');
    const moved = (await repo.getAppointment(created.id))!;
    expect(moved).toMatchObject({ eventId: appointment.eventId, start: slot.start, revision: 2 });
    const repeatedBooking = await tool(created, 'book_appointment', {
      serviceId: appointment.serviceId,
      ...slot,
    });
    expect(repeatedBooking.status).toBe('completed');
    expect((repeatedBooking.result as any).input.start).toBe(slot.start);
    expect((await repo.getActions(created.id)).find((a) => a.kind === 'appointment')!.input).toMatchObject({
      start: appointment.start,
    });
    const stale = await tool(created, 'cancel_appointment', { expectedRevision: 1 });
    expect(stale.status).toBe('failed');
    expect(stale.confirmationId).toBeUndefined();
    expect((await repo.getAppointment(created.id))?.status).toBe('booked');
    const cancel = await tool(created, 'cancel_appointment', { expectedRevision: 2 });
    expect((await runtime.confirm(created.id, cancel.confirmationId!, true)).status).toBe('completed');
    expect(await repo.getAppointment(created.id)).toMatchObject({ status: 'cancelled', revision: 3 });
    expect(
      (await repo.listRepairJobs(created.id)).find((j) => j.appointmentId === appointment.id)?.status,
    ).toBe('cancelled');
    expect((await getCalendarService('rehearsal').listSlots({ durationMinutes: 60 })).slots).toContainEqual(
      slot,
    );
    expect(
      (
        await tool(created, 'book_appointment', {
          serviceId: appointment.serviceId,
          start: appointment.start,
          end: appointment.end,
        })
      ).status,
    ).toBe('failed');
  });
  it('allows only customer approval of the actual persisted quote and preserves the lifecycle history', async () => {
    const created = await session();
    const quoted = (await repo.getRepairJob(created.id, 'REP-1042'))!;
    expect(quoted).toMatchObject({ status: 'awaiting_approval', estimateAMD: 20000, revision: 1 });
    await expect(
      repo.transitionRepairJob(
        created.id,
        quoted.id,
        { status: 'in_progress', expectedRevision: 1, note: 'Start now' },
        'operator',
      ),
    ).rejects.toThrow('Customer confirmation');
    const wrongAmount = await tool(created, 'approve_repair_quote', {
      jobId: quoted.id,
      expectedRevision: 1,
      expectedEstimateAMD: 100,
    });
    expect(wrongAmount.status).toBe('failed');
    expect(wrongAmount.confirmationId).toBeUndefined();
    expect((await repo.getRepairJob(created.id, quoted.id))?.status).toBe('awaiting_approval');
    await repo.updateSession(created.id, {
      handoff: {
        status: 'accepted',
        reason: 'Quote review',
        summary: 'Review quote',
        requestedAt: new Date().toISOString(),
        acceptedAt: new Date().toISOString(),
      },
    });
    const approval = await tool(created, 'approve_repair_quote', {
      jobId: quoted.id,
      expectedRevision: 1,
      expectedEstimateAMD: 20000,
    });
    expect(approval.status).toBe('pending-confirmation');
    expect((await runtime.confirm(created.id, approval.confirmationId!, true)).status).toBe('completed');
    const ready = await repo.transitionRepairJob(
      created.id,
      quoted.id,
      { status: 'ready', expectedRevision: 2, note: 'Bench checks passed.' },
      'operator',
    );
    const completed = await repo.transitionRepairJob(
      created.id,
      quoted.id,
      { status: 'completed', expectedRevision: ready.revision, note: 'Collected by customer.' },
      'operator',
    );
    expect(completed.history.map((h) => h.status)).toEqual([
      'awaiting_approval',
      'in_progress',
      'ready',
      'completed',
    ]);
    expect(completed.history[1].actor).toBe('customer');
  });
  it('prevents rescheduling after diagnosis starts and enforces quote approval before repair', async () => {
    const { session: created, appointment } = await book();
    const job = (await repo.listRepairJobs(created.id)).find((j) => j.appointmentId === appointment.id)!;
    await repo.transitionRepairJob(
      created.id,
      job.id,
      { status: 'diagnosing', expectedRevision: 1, note: 'Received for diagnosis.' },
      'operator',
    );
    await expect(
      repo.changeAppointment(created.id, appointment.id, 1, { status: 'cancelled' }, async () => {
        throw Error('must not call calendar');
      }),
    ).rejects.toThrow('Diagnosis or repair has started');
    await expect(
      repo.transitionRepairJob(
        created.id,
        job.id,
        { status: 'in_progress', expectedRevision: 2, note: 'Skip quote.' },
        'operator',
      ),
    ).rejects.toThrow('not allowed');
    const quote = await repo.transitionRepairJob(
      created.id,
      job.id,
      {
        status: 'awaiting_approval',
        estimateAMD: 12000,
        expectedRevision: 2,
        note: 'Customer quote prepared.',
      },
      'operator',
    );
    expect(quote).toMatchObject({ estimateAMD: 12000, status: 'awaiting_approval' });
  });
  it('rolls back failed calendar changes and rejects concurrent stale mutations', async () => {
    const { session: created, appointment } = await book();
    await expect(
      repo.changeAppointment(created.id, appointment.id, 1, { status: 'cancelled' }, async () => {
        throw Error('Calendar timeout');
      }),
    ).rejects.toThrow('Calendar timeout');
    expect((await repo.getAppointment(created.id))?.revision).toBe(1);
    let mutations = 0;
    const results = await Promise.allSettled([
      repo.changeAppointment(created.id, appointment.id, 1, { status: 'cancelled' }, async () => {
        mutations++;
      }),
      repo.changeAppointment(
        created.id,
        appointment.id,
        1,
        { status: 'booked', start: appointment.start, end: appointment.end },
        async () => {
          mutations++;
        },
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(mutations).toBe(1);
  });
  it('fails live booking clearly without Google configuration and cannot leak another owner job', async () => {
    const live = await runtime.startSession('repair-booking', 'live');
    const result = await tool(live, 'list_available_slots', { serviceId: 'workshop-diagnosis' });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Live booking requires');
    expect(await repo.getAppointment(live.id)).toBeNull();
    const { session: other, appointment } = await book();
    const job = (await repo.listRepairJobs(other.id)).find((j) => j.appointmentId === appointment.id)!;
    await expect(
      repo.transitionRepairJob(
        live.id,
        job.id,
        { status: 'diagnosing', expectedRevision: 1, note: 'Foreign access' },
        'operator',
      ),
    ).rejects.toThrow('not found');
  });
  it('keeps persisted rehearsal reservations after a calendar restart and exposes explicit local labels', async () => {
    const { session: created, appointment } = await book();
    const freshCalendar = new CalendarService({ env: { GOOGLE_CALENDAR_TIME_ZONE: 'Asia/Yerevan' } });
    const restarted = vi
      .spyOn(getCalendarService('rehearsal'), 'listSlots')
      .mockImplementation((input) => freshCalendar.listSlots(input));
    try {
      const raw = await freshCalendar.listSlots({ durationMinutes: 60 });
      expect(raw.slots).toContainEqual({ start: appointment.start, end: appointment.end });
      const result = await tool(created, 'list_available_slots', { serviceId: 'workshop-diagnosis' });
      expect(result.status).toBe('completed');
      const returned = result.result as any;
      expect(returned.slots).not.toContainEqual({ start: appointment.start, end: appointment.end });
      expect(returned.displaySlots[0]).toMatchObject({
        timeZone: 'Asia/Yerevan',
        startLocal: expect.stringMatching(/^\d{2}:\d{2}$/),
        label: expect.stringContaining('(Asia/Yerevan)'),
      });
      const expectedHour = (new Date(returned.displaySlots[0].start).getUTCHours() + 4) % 24;
      expect(Number(returned.displaySlots[0].startLocal.split(':')[0])).toBe(expectedHour);
      expect(
        (await repo.listCalendarReservations('demo')).every(
          (reservation) => Object.keys(reservation).sort().join(',') === 'end,start',
        ),
      ).toBe(true);
    } finally {
      restarted.mockRestore();
    }
  });
  it('serializes competing bookings across repository instances before provider mutation', async () => {
    const first = await session(),
      second = await session();
    await tool(first, 'list_available_slots', { serviceId: 'workshop-diagnosis' });
    const slot = (await repo.getSession(first.id)).snapshot.business!.offeredSlots![0];
    const requested = { serviceId: 'workshop-diagnosis', provider: 'demo' as const, ...slot };
    let providerCalls = 0;
    const create = (id: string) => async () => {
      providerCalls++;
      return {
        ...requested,
        eventId:
          'demo-' +
          createHash('sha256')
            .update(JSON.stringify([id, 'appointment']))
            .digest('hex'),
      };
    };
    const otherWorker = new PostgresRepository(database);
    const results = await Promise.allSettled([
      repo.bookAppointment(first.id, requested, create(first.id)),
      otherWorker.bookAppointment(second.id, requested, create(second.id)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(providerCalls).toBe(1);
  });
  it('backfills existing Google calendar actions and marks their source session live without provider calls', async () => {
    const created = await session();
    const saved = await repo.createAction(
      created.id,
      'appointment',
      {
        serviceId: 'workshop-diagnosis',
        provider: 'google',
        eventId: 'a'.repeat(64),
        start: '2030-01-01T05:00:00.000Z',
        end: '2030-01-01T06:00:00.000Z',
      },
      'legacy-google-fixture',
    );
    await database.query(
      await readFile(new URL('../packages/db/migrations/006_repair_lifecycle.sql', import.meta.url), 'utf8'),
    );
    expect(await repo.getAppointment(created.id)).toMatchObject({
      id: saved.id,
      provider: 'google',
      eventId: 'a'.repeat(64),
      status: 'booked',
    });
    expect((await repo.getSession(created.id)).mode).toBe('live');
    expect((await repo.listRepairJobs(created.id)).some((job) => job.appointmentId === saved.id)).toBe(true);
  });
  it('rejects an already-reviewed quote when the operator revises it before confirmation', async () => {
    const created = await session();
    const proposal = await tool(created, 'approve_repair_quote', {
      jobId: 'REP-1042',
      expectedRevision: 1,
      expectedEstimateAMD: 20000,
    });
    expect(proposal.status).toBe('pending-confirmation');
    await repo.transitionRepairJob(
      created.id,
      'REP-1042',
      { status: 'diagnosing', expectedRevision: 1, note: 'Rechecking the estimate.' },
      'operator',
    );
    await repo.transitionRepairJob(
      created.id,
      'REP-1042',
      {
        status: 'awaiting_approval',
        expectedRevision: 2,
        estimateAMD: 25000,
        note: 'A revised quote needs approval.',
      },
      'operator',
    );
    expect((await runtime.confirm(created.id, proposal.confirmationId!, true)).status).toBe('failed');
    expect(await repo.getRepairJob(created.id, 'REP-1042')).toMatchObject({
      status: 'awaiting_approval',
      estimateAMD: 25000,
      revision: 3,
    });
  });
});
