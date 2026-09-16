import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type {
  AppointmentChange,
  AppointmentRecord,
  RepairJob,
  RepairJobTransition,
  SupportSession,
} from '../../core/src/domain.js';

const access = `(r.session_id=$1::uuid OR EXISTS (SELECT 1 FROM api_session_owners requester JOIN api_session_owners owner ON requester.owner_hash=owner.owner_hash WHERE requester.session_id=$1::text AND owner.session_id=r.session_id::text))`;
const appointment = (row: any): AppointmentRecord => ({
  ...row.data,
  id: row.id,
  sessionId: row.session_id,
  revision: row.revision,
});
const job = (row: any): RepairJob => ({
  ...row.data,
  id: row.reference,
  sessionId: row.session_id,
  revision: row.revision,
});

/** Persistent lifecycle with session/owner scope checked on every read and mutation. */
export class RepairLifecycle {
  constructor(private database: pg.Pool) {}
  async getAppointment(sessionId: string, id?: string): Promise<AppointmentRecord | null> {
    const { rows } = await this.database.query(
      `SELECT r.* FROM appointment_records r WHERE ${access} AND (($2::uuid IS NULL AND r.session_id=$1::uuid) OR r.id=$2::uuid)`,
      [sessionId, id ?? null],
    );
    return rows[0] ? appointment(rows[0]) : null;
  }
  async listCalendarReservations(provider: 'demo' | 'google'): Promise<{ start: string; end: string }[]> {
    const { rows } = await this.database.query(
      `SELECT data->>'start' AS start,data->>'end' AS end FROM appointment_records WHERE data->>'provider'=$1 AND data->>'status'='booked' AND (data->>'end')::timestamptz>now()`,
      [provider],
    );
    return rows;
  }
  private async calendarLock(client: pg.PoolClient) {
    // Shared by every worker and every appointment mutation, including provider calls.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':relay-calendar-lifecycle'))",
    );
  }
  private async ensureAvailable(
    client: pg.PoolClient,
    input: { provider: string; start: string; end: string },
    exceptId?: string,
  ) {
    const { rows } = await client.query(
      `SELECT id FROM appointment_records WHERE data->>'provider'=$1 AND data->>'status'='booked' AND ($4::uuid IS NULL OR id<>$4::uuid) AND (data->>'start')::timestamptz<$3::timestamptz AND (data->>'end')::timestamptz>$2::timestamptz LIMIT 1`,
      [input.provider, input.start, input.end, exceptId ?? null],
    );
    if (rows.length)
      throw Object.assign(new Error('That time is no longer available. Please choose another slot.'), {
        code: 'SLOT_UNAVAILABLE',
      });
  }
  private async saveWithClient(
    client: pg.PoolClient,
    session: SupportSession,
    input: Omit<AppointmentRecord, 'id' | 'sessionId' | 'revision' | 'status'>,
  ) {
    const { rows } = await client.query(
      `INSERT INTO appointment_records(id,session_id,data) VALUES($1,$2,$3) ON CONFLICT(session_id) DO UPDATE SET session_id=EXCLUDED.session_id RETURNING *`,
      [randomUUID(), session.id, JSON.stringify({ ...input, status: 'booked' })],
    );
    const record = appointment(rows[0]);
    if (record.eventId !== input.eventId || record.serviceId !== input.serviceId)
      throw new Error('This session already has a different appointment');
    if (session.snapshot.repair) {
      const repair = session.snapshot.repair;
      const reference = `REP-${record.id.slice(0, 8).toUpperCase()}`;
      const note = 'Diagnosis appointment booked. Repair has not started.';
      const data = {
        customerId: session.customerId,
        contactName: repair.contactName,
        contactPhone: repair.contactPhone,
        appliance: repair.appliance ?? 'unspecified',
        model: repair.model ?? 'Not supplied',
        issue: repair.issue ?? 'Diagnosis requested',
        status: 'scheduled',
        note,
        readyAt: null,
        appointmentId: record.id,
        history: [{ status: 'scheduled', note, at: new Date().toISOString(), actor: 'system' }],
      };
      await client.query(
        `INSERT INTO repair_jobs(id,reference,session_id,data) VALUES($1,$2,$3,$4) ON CONFLICT(session_id,reference) DO NOTHING`,
        [randomUUID(), reference, session.id, JSON.stringify(data)],
      );
    }
    return record;
  }
  async saveAppointment(
    session: SupportSession,
    input: Omit<AppointmentRecord, 'id' | 'sessionId' | 'revision' | 'status'>,
  ) {
    return this.bookAppointment(session, input, async () => input);
  }
  async bookAppointment(
    session: SupportSession,
    requested: Pick<AppointmentRecord, 'serviceId' | 'provider' | 'start' | 'end'>,
    create: () => Promise<Omit<AppointmentRecord, 'id' | 'sessionId' | 'revision' | 'status'>>,
  ) {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      await this.calendarLock(client);
      await client.query('SELECT id FROM support_sessions WHERE id=$1 FOR UPDATE', [session.id]);
      const existing = await client.query('SELECT * FROM appointment_records WHERE session_id=$1', [
        session.id,
      ]);
      if (existing.rows[0]) {
        const record = appointment(existing.rows[0]);
        if (
          record.status !== 'booked' ||
          record.serviceId !== requested.serviceId ||
          record.provider !== requested.provider ||
          record.start !== requested.start ||
          record.end !== requested.end
        )
          throw new Error('This session already has a different or cancelled appointment');
        await client.query('COMMIT');
        return record;
      }
      await this.ensureAvailable(client, requested);
      const input = await create();
      if (
        input.provider !== requested.provider ||
        input.serviceId !== requested.serviceId ||
        Date.parse(input.start) !== Date.parse(requested.start) ||
        Date.parse(input.end) !== Date.parse(requested.end)
      )
        throw new Error('Calendar result did not match the requested appointment');
      const result = await this.saveWithClient(client, session, input);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async seedSessionJobs(session: SupportSession) {
    for (const fixture of session.snapshot.repair?.jobs ?? []) {
      const note = fixture.note;
      await this.database.query(
        `INSERT INTO repair_jobs(id,reference,session_id,data) VALUES($1,$2,$3,$4) ON CONFLICT(session_id,reference) DO NOTHING`,
        [
          randomUUID(),
          fixture.id,
          session.id,
          JSON.stringify({
            ...fixture,
            issue: 'Demo repair inquiry',
            history: [{ status: fixture.status, note, at: new Date().toISOString(), actor: 'system' }],
          }),
        ],
      );
    }
  }
  async listRepairJobs(sessionId: string): Promise<RepairJob[]> {
    const { rows } = await this.database.query(
      `SELECT DISTINCT ON(r.reference) r.* FROM repair_jobs r JOIN support_sessions s ON s.id=r.session_id WHERE ${access} AND (r.data->>'customerId')=(SELECT customer_id FROM support_sessions WHERE id=$1::uuid) ORDER BY r.reference,(r.session_id=$1::uuid) DESC,r.created_at DESC`,
      [sessionId],
    );
    return rows.map(job);
  }
  async getRepairJob(sessionId: string, id: string): Promise<RepairJob | null> {
    return (
      (await this.listRepairJobs(sessionId)).find((j) => j.id.toUpperCase() === id.toUpperCase()) ?? null
    );
  }
  async changeAppointment(
    sessionId: string,
    id: string,
    expectedRevision: number,
    change: AppointmentChange,
    mutate: (record: AppointmentRecord) => Promise<void>,
  ): Promise<AppointmentRecord> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      await this.calendarLock(client);
      const { rows } = await client.query(
        `SELECT r.* FROM appointment_records r WHERE ${access} AND r.id=$2 FOR UPDATE`,
        [sessionId, id],
      );
      if (!rows[0]) throw new Error('Appointment not found for this session owner');
      const current = appointment(rows[0]);
      const matches =
        current.status === change.status &&
        (change.status === 'cancelled' || (current.start === change.start && current.end === change.end));
      // A retry after external success/local response loss returns the same persisted revision.
      if (matches && current.revision === expectedRevision + 1) {
        await client.query('COMMIT');
        return current;
      }
      if (current.revision !== expectedRevision)
        throw new Error('Appointment changed; review its current details before confirming again');
      if (current.status === 'cancelled') throw new Error('This appointment is already cancelled');
      const repairRows = await client.query(
        `SELECT * FROM repair_jobs WHERE session_id=$1 AND data->>'appointmentId'=$2 FOR UPDATE`,
        [current.sessionId, current.id],
      );
      if (repairRows.rows.some((row) => !['scheduled'].includes(row.data.status)))
        throw new Error('Diagnosis or repair has started; ask an operator before changing the appointment');
      if (change.status === 'booked')
        await this.ensureAvailable(
          client,
          { provider: current.provider, start: change.start, end: change.end },
          current.id,
        );
      await mutate(current);
      const next = { ...current, ...change, revision: current.revision + 1 };
      await client.query('UPDATE appointment_records SET data=$2,revision=$3 WHERE id=$1', [
        id,
        JSON.stringify(next),
        next.revision,
      ]);
      for (const row of repairRows.rows) {
        const data = row.data;
        const note =
          change.status === 'cancelled'
            ? 'Diagnosis appointment cancelled by the customer.'
            : `Diagnosis appointment rescheduled to ${next.start}.`;
        const status = change.status === 'cancelled' ? 'cancelled' : data.status;
        await client.query('UPDATE repair_jobs SET data=$2,revision=revision+1 WHERE id=$1', [
          row.id,
          JSON.stringify({
            ...data,
            status,
            note,
            history: [...data.history, { status, note, at: new Date().toISOString(), actor: 'customer' }],
          }),
        ]);
      }
      await client.query('COMMIT');
      return next;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async transitionRepairJob(
    sessionId: string,
    id: string,
    input: RepairJobTransition,
    actor: 'operator' | 'customer',
  ): Promise<RepairJob> {
    if (!input.note.trim() || input.note.length > 2000 || !Number.isInteger(input.expectedRevision))
      throw new Error('A bounded note and current revision are required');
    if (
      input.estimateAMD !== undefined &&
      (!Number.isInteger(input.estimateAMD) || input.estimateAMD < 0 || input.estimateAMD > 10000000)
    )
      throw new Error('Invalid quote amount');
    if (input.readyAt && !Number.isFinite(Date.parse(input.readyAt)))
      throw new Error('Invalid confirmed completion date');
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT r.* FROM repair_jobs r WHERE ${access} AND upper(r.reference)=upper($2) ORDER BY (r.session_id=$1::uuid) DESC,r.created_at DESC LIMIT 1 FOR UPDATE`,
        [sessionId, id],
      );
      if (!rows[0]) throw new Error('Repair job not found for this session owner');
      const current = job(rows[0]);
      if (
        current.customerId !==
        (await client.query('SELECT customer_id FROM support_sessions WHERE id=$1', [sessionId])).rows[0]
          ?.customer_id
      )
        throw new Error('Repair job not found for this customer');
      if (
        actor === 'customer' &&
        current.status === 'in_progress' &&
        current.revision === input.expectedRevision + 1 &&
        current.history.at(-1)?.actor === 'customer'
      ) {
        await client.query('COMMIT');
        return current;
      }
      if (current.revision !== input.expectedRevision)
        throw new Error('Repair job changed; refresh before applying an update');
      const transitions: Record<string, string[]> = {
        scheduled: ['diagnosing'],
        diagnosing: ['awaiting_approval'],
        awaiting_approval: ['in_progress', 'diagnosing'],
        in_progress: ['ready'],
        ready: ['completed'],
        completed: [],
        cancelled: [],
      };
      if (!transitions[current.status]?.includes(input.status))
        throw new Error('This repair status transition is not allowed');
      if (actor === 'customer' && !(current.status === 'awaiting_approval' && input.status === 'in_progress'))
        throw new Error('Customers may only approve the current repair quote');
      if (actor === 'operator' && current.status === 'awaiting_approval' && input.status === 'in_progress')
        throw new Error('Customer confirmation is required before repair begins');
      const estimateAMD =
        actor === 'customer' ? current.estimateAMD : (input.estimateAMD ?? current.estimateAMD);
      if (['awaiting_approval', 'in_progress'].includes(input.status) && estimateAMD === undefined)
        throw new Error('A repair quote is required before approval');
      const at = new Date().toISOString();
      const next: RepairJob = {
        ...current,
        status: input.status,
        note: input.note.trim(),
        estimateAMD,
        readyAt: input.readyAt === undefined ? current.readyAt : input.readyAt,
        revision: current.revision + 1,
        history: [...current.history, { status: input.status, note: input.note.trim(), at, actor }],
      };
      await client.query('UPDATE repair_jobs SET data=$2,revision=$3 WHERE id=$1', [
        rows[0].id,
        JSON.stringify(next),
        next.revision,
      ]);
      await client.query('COMMIT');
      return next;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
