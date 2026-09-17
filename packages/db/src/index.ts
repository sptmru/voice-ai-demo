import { scenarioIds } from '../../core/src/domain.js';
import { RepairLifecycle } from './repair-lifecycle.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { databaseUrl } from './config.js';
import { sanitize } from '../../core/src/redaction.js';
import type {
  AgentEvent,
  Customer,
  EventType,
  MemoryItem,
  PendingConfirmation,
  Repository,
  ScenarioId,
  SupportSession,
  Ticket,
} from '../../core/src/domain.js';

export const pool = new pg.Pool({
  connectionString: databaseUrl(),
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});
pool.on('error', (error) => console.error('PostgreSQL pool error:', error.message));

type Row = Record<string, any>;
const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : value);
const sessionFromRow = (row: Row): SupportSession => ({
  id: row.id,
  customerId: row.customer_id,
  scenarioId: row.scenario_id,
  status: row.status,
  mode: row.mode ?? 'rehearsal',
  createdAt: iso(row.created_at),
  endedAt: row.ended_at ? iso(row.ended_at) : null,
  snapshot: row.snapshot,
  outcome: row.outcome,
  diagnosis: row.diagnosis,
  ...(row.handoff ? { handoff: row.handoff } : {}),
});
const confirmationFromRow = (row: Row): PendingConfirmation => ({
  id: row.id,
  sessionId: row.session_id,
  toolName: row.tool_name,
  input: row.input,
  status: row.status,
  expiresAt: iso(row.expires_at),
  ...(row.result !== null ? { result: row.result } : {}),
});
const ticketFromRow = (row: Row): Ticket => ({
  id: row.id,
  sessionId: row.session_id,
  customerId: row.customer_id,
  subject: row.subject,
  description: row.description,
  severity: row.severity,
  status: row.status,
  createdAt: iso(row.created_at),
});
const actionFromRow = (row: Row): Record<string, unknown> => ({
  id: row.id,
  sessionId: row.session_id,
  customerId: row.customer_id,
  kind: row.kind,
  input: row.input,
  status: row.status,
  createdAt: iso(row.created_at),
  dispatch:
    ['appointment', 'appointment-rescheduled', 'appointment-cancelled'].includes(row.kind) &&
    row.input?.provider === 'google'
      ? `${row.kind === 'appointment-cancelled' ? 'Cancelled' : row.kind === 'appointment-rescheduled' ? 'Updated' : 'Created'} in Google Calendar; no attendee invitations sent.`
      : 'Demo: recorded locally; no external message or fulfillment change sent.',
});

export class PostgresRepository implements Repository {
  constructor(public readonly database: pg.Pool = pool) {}

  listCalendarReservations: NonNullable<Repository['listCalendarReservations']> = (provider) =>
    new RepairLifecycle(this.database).listCalendarReservations(provider);
  bookAppointment: NonNullable<Repository['bookAppointment']> = async (sessionId, requested, create) =>
    new RepairLifecycle(this.database).bookAppointment(await this.getSession(sessionId), requested, create);
  getAppointment: NonNullable<Repository['getAppointment']> = (sessionId, id) =>
    new RepairLifecycle(this.database).getAppointment(sessionId, id);
  saveAppointment: NonNullable<Repository['saveAppointment']> = async (sessionId, input) =>
    new RepairLifecycle(this.database).saveAppointment(await this.getSession(sessionId), input);
  changeAppointment: NonNullable<Repository['changeAppointment']> = (...args) =>
    new RepairLifecycle(this.database).changeAppointment(...args);
  listRepairJobs: NonNullable<Repository['listRepairJobs']> = (sessionId) =>
    new RepairLifecycle(this.database).listRepairJobs(sessionId);
  getRepairJob: NonNullable<Repository['getRepairJob']> = (sessionId, id) =>
    new RepairLifecycle(this.database).getRepairJob(sessionId, id);
  transitionRepairJob: NonNullable<Repository['transitionRepairJob']> = (...args) =>
    new RepairLifecycle(this.database).transitionRepairJob(...args);

  async getCustomer(id: string): Promise<Customer> {
    const { rows } = await this.database.query('SELECT data FROM customers WHERE id=$1', [id]);
    if (!rows[0]) throw new Error('Customer not found');
    return rows[0].data;
  }

  async createSession(
    scenario: ScenarioId,
    mode: import('../../core/src/domain.js').SessionMode = 'rehearsal',
  ): Promise<SupportSession> {
    const { rows } = await this.database.query(
      `INSERT INTO support_sessions(id,customer_id,scenario_id,snapshot,mode)
      SELECT $1,customer_id,id,snapshot,$3 FROM scenario_templates WHERE id=$2 RETURNING *`,
      [randomUUID(), scenario, mode],
    );
    if (!rows[0]) throw new Error('Scenario not found; run pnpm db:seed');
    const session = sessionFromRow(rows[0]);
    await new RepairLifecycle(this.database).seedSessionJobs(session);
    return session;
  }

  async getSession(id: string): Promise<SupportSession> {
    const { rows } = await this.database.query('SELECT * FROM support_sessions WHERE id=$1', [id]);
    if (!rows[0]) throw Object.assign(new Error('Session not found'), { status: 404 });
    return sessionFromRow(rows[0]);
  }

  async listSessions(allowedIds?: string[]): Promise<SupportSession[]> {
    const { rows } = await this.database.query(
      'SELECT * FROM support_sessions WHERE ($1::uuid[] IS NULL OR id=ANY($1::uuid[])) AND scenario_id=ANY($2::text[]) ORDER BY created_at DESC,id LIMIT 100',
      [allowedIds ?? null, scenarioIds],
    );
    return rows.map(sessionFromRow);
  }

  async deleteSession(id: string): Promise<boolean> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      // Lock the parent first: concurrent writes referencing this session cannot
      // insert memory between the explicit cleanup and the cascading deletion.
      const session = await client.query('SELECT id FROM support_sessions WHERE id=$1 FOR UPDATE', [id]);
      if (!session.rowCount) {
        await client.query('COMMIT');
        return false;
      }
      await client.query('DELETE FROM customer_memory WHERE source_session_id=$1', [id]);
      await client.query('DELETE FROM api_session_owners WHERE session_id=$1', [id]);
      // Events, tickets, actions and confirmations already use ON DELETE CASCADE.
      await client.query('DELETE FROM support_sessions WHERE id=$1', [id]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async updateSession(id: string, patch: Parameters<Repository['updateSession']>[1]): Promise<void> {
    const fields = {
      status: 'status',
      endedAt: 'ended_at',
      diagnosis: 'diagnosis',
      outcome: 'outcome',
      snapshot: 'snapshot',
      handoff: 'handoff',
    } as const;
    const entries = Object.entries(patch).filter(([key, value]) => key in fields && value !== undefined);
    if (!entries.length) return;
    const assignments = entries.map(([key], index) => `${fields[key as keyof typeof fields]}=$${index + 2}`);
    const values = entries.map(([key, value]) =>
      key === 'snapshot' || key === 'handoff'
        ? JSON.stringify(value)
        : key === 'outcome'
          ? JSON.stringify(sanitize(value))
          : key === 'diagnosis'
            ? sanitize(value)
            : value,
    );
    const result = await this.database.query(
      `UPDATE support_sessions SET ${assignments.join(',')} WHERE id=$1`,
      [id, ...values],
    );
    if (!result.rowCount) throw new Error('Session not found');
  }

  async appendEvent(
    sessionId: string,
    type: EventType,
    payload: Record<string, unknown>,
    durationMs?: number,
    correlationId = randomUUID(),
  ): Promise<AgentEvent> {
    const { rows } = await this.database.query(
      `INSERT INTO agent_events(session_id,correlation_id,type,payload,duration_ms)
      VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [sessionId, correlationId, type, JSON.stringify(sanitize(payload)), durationMs ?? null],
    );
    return this.eventFromRow(rows[0]);
  }

  private eventFromRow(row: Row): AgentEvent {
    return {
      id: Number(row.id),
      sessionId: row.session_id,
      correlationId: row.correlation_id,
      timestamp: iso(row.created_at),
      type: row.type,
      payload: row.payload,
      ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
    };
  }

  async getEvents(sessionId: string, afterId = 0): Promise<AgentEvent[]> {
    const { rows } = await this.database.query(
      'SELECT * FROM agent_events WHERE session_id=$1 AND id>$2 ORDER BY id',
      [sessionId, afterId],
    );
    return rows.map((row) => this.eventFromRow(row));
  }

  async createTicket(sessionId: string, input: Parameters<Repository['createTicket']>[1]): Promise<Ticket> {
    input = sanitize(input) as typeof input;
    const { rows } = await this.database.query(
      `INSERT INTO support_tickets(id,session_id,customer_id,subject,description,severity)
      SELECT $1,id,customer_id,$3,$4,$5 FROM support_sessions WHERE id=$2
      ON CONFLICT(session_id,subject,description) DO UPDATE SET subject=EXCLUDED.subject RETURNING *`,
      [
        `TKT-${randomUUID().slice(0, 8).toUpperCase()}`,
        sessionId,
        input.subject,
        input.description,
        input.severity,
      ],
    );
    if (!rows[0]) throw new Error('Session not found');
    return ticketFromRow(rows[0]);
  }

  async getTickets(sessionId: string): Promise<Ticket[]> {
    const { rows } = await this.database.query(
      'SELECT * FROM support_tickets WHERE session_id=$1 ORDER BY created_at',
      [sessionId],
    );
    return rows.map(ticketFromRow);
  }

  async createAction(
    sessionId: string,
    kind: string,
    input: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    input = sanitize(input) as typeof input;
    const { rows } = await this.database.query(
      `INSERT INTO support_actions(id,session_id,customer_id,kind,input,idempotency_key,status)
      SELECT $1,id,customer_id,$3,$4,$5,$6 FROM support_sessions WHERE id=$2
      ON CONFLICT(session_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING *`,
      [
        randomUUID(),
        sessionId,
        kind,
        JSON.stringify(input),
        idempotencyKey,
        ['appointment', 'appointment-rescheduled', 'appointment-cancelled'].includes(kind) &&
        input.provider === 'google'
          ? 'confirmed_external'
          : 'recorded_locally',
      ],
    );
    if (!rows[0]) throw new Error('Session not found');
    if (
      rows[0].kind !== kind ||
      JSON.stringify(sortObject(rows[0].input)) !== JSON.stringify(sortObject(input))
    )
      throw new Error('Idempotency key already used for a different action');
    return actionFromRow(rows[0]);
  }

  async getActions(sessionId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.database.query(
      'SELECT * FROM support_actions WHERE session_id=$1 ORDER BY created_at',
      [sessionId],
    );
    return rows.map(actionFromRow);
  }

  async createConfirmation(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PendingConfirmation> {
    const { rows } = await this.database.query(
      `INSERT INTO pending_confirmations(id,session_id,tool_name,input)
      VALUES($1,$2,$3,$4) RETURNING *`,
      [randomUUID(), sessionId, toolName, JSON.stringify(sanitize(input))],
    );
    return confirmationFromRow(rows[0]);
  }

  async getConfirmations(sessionId: string): Promise<PendingConfirmation[]> {
    await this.database.query(
      "UPDATE pending_confirmations SET status='expired' WHERE session_id=$1 AND status='pending' AND expires_at<=now()",
      [sessionId],
    );
    const { rows } = await this.database.query(
      'SELECT * FROM pending_confirmations WHERE session_id=$1 ORDER BY created_at',
      [sessionId],
    );
    return rows.map(confirmationFromRow);
  }

  /** Approval is a single-use authorization claim, never proof that execution succeeded. */
  async resolveConfirmation(sessionId: string, id: string, approve: boolean): Promise<PendingConfirmation> {
    const { rows } = await this.database.query(
      `UPDATE pending_confirmations SET status=$3
      WHERE id=$1 AND session_id=$2 AND status='pending' AND expires_at>now() RETURNING *`,
      [id, sessionId, approve ? 'approved' : 'rejected'],
    );
    if (!rows[0]) {
      await this.database.query(
        "UPDATE pending_confirmations SET status='expired' WHERE id=$1 AND session_id=$2 AND status='pending' AND expires_at<=now()",
        [id, sessionId],
      );
      throw new Error('Confirmation is unavailable, expired or already used');
    }
    return confirmationFromRow(rows[0]);
  }

  async getMemory(customerId: string, query = ''): Promise<MemoryItem[]> {
    // Remove conversational history intent, then OR the remaining topic words. PostgreSQL still
    // stems the terms and removes ordinary English stopwords. Generic history requests get recent cases.
    const historyWords = new Set([
      'what',
      'when',
      'where',
      'why',
      'how',
      'happened',
      'happen',
      'previous',
      'previously',
      'history',
      'historical',
      'last',
      'earlier',
      'old',
      'recent',
      'remember',
      'recall',
      'show',
      'tell',
      'please',
      'can',
      'could',
      'would',
      'about',
      'with',
      'from',
      'have',
      'had',
      'did',
      'was',
      'were',
      'the',
      'this',
      'that',
      'our',
      'their',
      'your',
      'my',
      'me',
      'us',
      'in',
      'on',
      'to',
      'of',
      'a',
      'an',
      'and',
      'for',
      'is',
      'it',
      'we',
      'i',
      'again',
      'time',
      'times',
      'case',
      'cases',
      'call',
      'calls',
      'session',
      'sessions',
      'support',
    ]);
    const terms = [
      ...new Set(
        (
          query
            .slice(0, 1000)
            .toLowerCase()
            .match(/[a-z0-9][a-z0-9_-]*/g) ?? []
        ).filter((term) => !historyWords.has(term)),
      ),
    ].slice(0, 20);
    const topic = terms.map((term) => `"${term}"`).join(' OR ');
    const { rows } = await this.database.query(
      `WITH query AS (
        SELECT websearch_to_tsquery('english',$2) AS topic
      ), ranked AS (
        SELECT memory.*,row_number() OVER(PARTITION BY kind
          ORDER BY ts_rank_cd(search_vector,query.topic) DESC,created_at DESC,id) AS kind_rank
        FROM customer_memory memory CROSS JOIN query WHERE customer_id=$1
          AND (source_session_id IS NULL OR EXISTS (SELECT 1 FROM support_sessions s WHERE s.id=memory.source_session_id AND s.scenario_id=ANY($3::text[])))
          AND (kind IN ('fact','preference') OR numnode(query.topic)=0 OR search_vector @@ query.topic)
      ) SELECT * FROM ranked WHERE kind_rank<=2
      ORDER BY kind_rank,CASE kind WHEN 'case' THEN 0 WHEN 'summary' THEN 1 WHEN 'fact' THEN 2 ELSE 3 END LIMIT 8`,
      [customerId, topic, scenarioIds],
    );
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      content: row.content,
      sourceSessionId: row.source_session_id,
      createdAt: iso(row.created_at),
    }));
  }

  async saveMemory(
    customerId: string,
    kind: MemoryItem['kind'],
    content: string,
    sessionId: string | null,
  ): Promise<void> {
    if (!content.trim() || content.length > 4000) throw new Error('Memory must contain 1–4000 characters');
    if (sessionId) {
      const session = await this.getSession(sessionId);
      if (session.customerId !== customerId) throw new Error('Memory customer does not own session');
    }
    content = String(sanitize(content));
    await this.database.query(
      `INSERT INTO customer_memory(id,customer_id,kind,content,source_session_id)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(customer_id,kind,content) DO NOTHING`,
      [randomUUID(), customerId, kind, content.trim(), sessionId],
    );
  }
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sortObject(child)]),
    );
  return value;
}
