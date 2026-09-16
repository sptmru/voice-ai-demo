import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  type AgentEvent,
  type MemoryItem,
  type PendingConfirmation,
  type Repository,
  type RetrievalService,
  type SupportSession,
  type Ticket,
} from '../packages/core/src/domain.js';
import { demoCustomer, scenarioSnapshot } from '../packages/db/src/fixtures.js';
import { requestedBusinessDate } from '../packages/core/src/business-runtime.js';
import { SupportRuntime } from '../packages/core/src/runtime.js';
import { sanitize, ToolExecutor } from '../packages/core/src/executor.js';

function fixture() {
  const sessions = new Map<string, SupportSession>();
  const events: AgentEvent[] = [];
  const tickets: Ticket[] = [];
  const confirmations: PendingConfirmation[] = [];
  const actions: Record<string, unknown>[] = [];
  const memories: MemoryItem[] = [];
  const repo: Repository = {
    getCustomer: async (id) => {
      if (id !== demoCustomer.id) throw Error('Customer not found');
      return demoCustomer;
    },
    createSession: async (scenario) => {
      const session: SupportSession = {
        id: randomUUID(),
        customerId: demoCustomer.id,
        scenarioId: scenario,
        status: 'active',
        createdAt: new Date().toISOString(),
        endedAt: null,
        diagnosis: null,
        outcome: null,
        snapshot: scenarioSnapshot(scenario),
      };
      sessions.set(session.id, session);
      return session;
    },
    getSession: async (id) => {
      const session = sessions.get(id);
      if (!session) throw Error('Session not found');
      return session;
    },
    listSessions: async () => [...sessions.values()],
    deleteSession: async (id) => sessions.delete(id),
    updateSession: async (id, patch) => {
      Object.assign(await repo.getSession(id), patch);
    },
    appendEvent: async (sessionId, type, payload, durationMs, correlationId) => {
      const event = {
        id: events.length + 1,
        sessionId,
        type,
        payload,
        durationMs,
        correlationId: correlationId ?? randomUUID(),
        timestamp: new Date().toISOString(),
      };
      events.push(event);
      return event;
    },
    getEvents: async (id, after = 0) => events.filter((e) => e.sessionId === id && e.id > after),
    createTicket: vi.fn(async (sessionId, input) => {
      const ticket = {
        id: `SUP-${tickets.length + 1}`,
        sessionId,
        customerId: demoCustomer.id,
        ...input,
        status: 'open',
        createdAt: new Date().toISOString(),
      };
      tickets.push(ticket);
      return ticket;
    }),
    getTickets: async (id) => tickets.filter((t) => t.sessionId === id),
    createAction: vi.fn(async (sessionId, kind, input, idempotencyKey) => {
      const prior = actions.find((a) => a.sessionId === sessionId && a.idempotencyKey === idempotencyKey);
      if (prior) return prior;
      const action = { id: randomUUID(), sessionId, kind, input, idempotencyKey };
      actions.push(action);
      if (kind === 'credential-reset') {
        const s = await repo.getSession(sessionId);
        s.snapshot.trunk.credentialsValid = true;
        s.snapshot.trunk.credentialVersion++;
      }
      return action;
    }),
    getActions: async (id) => actions.filter((a) => a.sessionId === id),
    createConfirmation: async (sessionId, toolName, input) => {
      const confirmation: PendingConfirmation = {
        id: randomUUID(),
        sessionId,
        toolName,
        input,
        status: 'pending',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
      confirmations.push(confirmation);
      return confirmation;
    },
    getConfirmations: async (id) => confirmations.filter((c) => c.sessionId === id),
    resolveConfirmation: async (sessionId, id, approve) => {
      const c = confirmations.find((c) => c.sessionId === sessionId && c.id === id);
      if (!c || c.status !== 'pending' || Date.parse(c.expiresAt) <= Date.now())
        throw Error('Confirmation unavailable');
      c.status = approve ? 'approved' : 'rejected';
      return c;
    },
    getMemory: async () => memories,
    saveMemory: async (_customerId, kind, content, sourceSessionId) => {
      memories.push({
        id: randomUUID(),
        kind,
        content,
        sourceSessionId,
        createdAt: new Date().toISOString(),
      });
    },
  };
  const rag: RetrievalService = {
    search: vi.fn(async () => [
      {
        chunkId: 'chunk-1',
        documentId: 'doc-1',
        document: 'UK troubleshooting',
        section: 'SIP 403',
        content: 'Check account, trunk and incidents.',
        source: 'docs/knowledge/uk.md',
        type: 'markdown',
        semanticScore: 0.8,
        lexicalScore: 0.5,
        combinedScore: 0.032,
      },
    ]),
    ingest: vi.fn(),
    listDocuments: async () => [],
    deleteDocument: async () => false,
  };
  return {
    repo,
    rag,
    sessions,
    events,
    tickets,
    confirmations,
    actions,
    memories,
    runtime: new SupportRuntime(repo, rag),
  };
}

const calendarMock = vi.hoisted(() => ({
  book: vi.fn(async (input: { start: string; end: string }) => ({
    provider: 'demo',
    eventId: 'demo-event-1',
    status: 'demo',
    start: input.start,
    end: input.end,
  })),
}));
vi.mock('../packages/integrations/src/calendar.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../packages/integrations/src/calendar.js')>()),
  getCalendarService: () => ({
    status: () => ({ configured: false, provider: 'demo', timeZone: 'UTC' }),
    listSlots: async () => ({
      provider: 'demo',
      timeZone: 'UTC',
      slots: [
        { start: '2030-09-16T10:00:00.000Z', end: '2030-09-16T10:30:00.000Z' },
        { start: '2030-09-16T14:00:00.000Z', end: '2030-09-16T14:30:00.000Z' },
      ],
    }),
    book: calendarMock.book,
  }),
}));

describe('business conversations', () => {
  it('offers slots before booking, persists one booking and does not require SIP recovery', async () => {
    const { runtime, repo, actions, rag } = fixture();
    const session = await runtime.startSession('appointment-booking');
    expect((await runtime.message(session.id, 'Book option 1')).text).toContain('choose an option');
    expect(actions).toHaveLength(0);
    expect((await runtime.message(session.id, 'Show available times')).text).toContain(
      'Local demo availability',
    );
    expect(actions).toHaveLength(0);
    expect((await runtime.message(session.id, 'Book option 1')).text).toContain('Local demo booking saved');
    expect((await repo.getSession(session.id)).outcome?.resolved).toBe(true);
    await runtime.message(session.id, 'Book option 1');
    expect(actions.filter((a) => a.kind === 'appointment')).toHaveLength(1);
    expect(rag.search).not.toHaveBeenCalled();
    expect((await runtime.endSession(session.id)).status).toBe('completed');
  });

  it('collects actual missing lead fields across turns before saving', async () => {
    const { runtime, actions, repo } = fixture();
    const session = await runtime.startSession('lead-qualification');
    expect((await runtime.message(session.id, 'We want a voice agent for incoming calls')).text).toContain(
      'budget',
    );
    expect(actions).toHaveLength(0);
    expect((await runtime.message(session.id, '$5000')).text).toContain('launch');
    expect(actions).toHaveLength(0);
    expect((await runtime.message(session.id, 'What timeline would you recommend?')).text).toContain(
      'launch',
    );
    expect(actions).toHaveLength(0);
    await runtime.message(session.id, 'Next month');
    expect(actions.filter((a) => a.kind === 'lead')).toHaveLength(1);
    expect(actions[0].input).toMatchObject({ budget: '$5000', timeline: 'Next month' });
    expect((await repo.getSession(session.id)).outcome?.intent).toBe('lead_qualification');
    await runtime.message(session.id, 'Book a meeting');
    await runtime.message(session.id, 'Book option 1');
    expect(actions.filter((a) => a.kind === 'appointment')).toHaveLength(1);
  });

  it('accepts the guided lead prompt and ends incomplete conversations honestly', async () => {
    const { runtime, actions } = fixture();
    const session = await runtime.startSession('lead-qualification');
    await runtime.message(session.id, 'Need: automate incoming calls; Budget: $5000; Timeline: next month');
    expect(actions[0].input).toMatchObject({
      need: 'automate incoming calls',
      budget: '$5000',
      timeline: 'next month',
    });
    const unfinished = await runtime.startSession('appointment-booking');
    const ended = await runtime.endSession(unfinished.id);
    expect(ended.outcome).toMatchObject({ intent: 'appointment_booking', resolved: false });
    expect(ended.outcome?.diagnosis).not.toContain('SIP');
  });

  it('checks order ownership and confirms the exact delivery request without changing fulfillment', async () => {
    const { runtime, actions, repo } = fixture();
    const session = await runtime.startSession('order-support');
    expect((await runtime.message(session.id, 'Where is ORD-9999?')).text).toContain('Order not found');
    await runtime.message(session.id, 'Where is order ORD-1042?');
    expect((await runtime.message(session.id, 'Change delivery to 25 Market Street, London')).text).toContain(
      'Confirm delivery change',
    );
    expect(actions).toHaveLength(0);
    await runtime.message(session.id, 'Confirm delivery change');
    expect(actions[0]).toMatchObject({
      kind: 'delivery-change',
      input: { address: '25 Market Street, London', fulfillment: 'unchanged', status: 'pending-review' },
    });
    expect((await repo.getSession(session.id)).snapshot.business?.orders[0].deliveryAddress).toBe(
      '10 King Street, London',
    );
    expect((await repo.getSession(session.id)).outcome?.resolved).toBe(false);
  });

  it('rejects invented successful outcomes, wrong scenario tools, and unoffered slots', async () => {
    const { runtime } = fixture();
    const session = await runtime.startSession('appointment-booking');
    const run = (name: string, input: unknown) =>
      runtime.executeTool(session.id, { id: randomUUID(), name, input });
    expect((await run('save_lead', { need: 'need', budget: 'budget', timeline: 'timeline' })).status).toBe(
      'failed',
    );
    expect((await run('reset_trunk_credentials', { reason: 'please reset' })).status).toBe('failed');
    expect(
      (
        await run('book_appointment', {
          serviceId: 'consultation',
          start: '2030-09-16T10:00:00.000Z',
          end: '2030-09-16T10:30:00.000Z',
        })
      ).status,
    ).toBe('failed');
    expect(
      (
        await run('complete_support_case', {
          intent: 'appointment_booking',
          severity: 'low',
          product: 'Consulting',
          issue: 'Booked',
          diagnosis: 'Done',
          resolved: true,
          nextAction: 'Attend meeting',
        })
      ).status,
    ).toBe('failed');
  });

  it('hands off with context, silences automation and allows factual session end', async () => {
    const { runtime, repo } = fixture();
    const session = await runtime.startSession('lead-qualification');
    await runtime.message(session.id, 'We want a voice agent for incoming calls');
    expect((await runtime.message(session.id, 'Talk to a person')).text).toContain('operator queue');
    expect((await repo.getSession(session.id)).handoff?.status).toBe('waiting');
    expect(await runtime.message(session.id, 'My budget is 5000')).toEqual({ text: '' });
    expect(await runtime.ensureVoiceOutcome(session.id)).toEqual([]);
    expect(
      (
        await runtime.executeTool(session.id, {
          id: randomUUID(),
          name: 'save_lead',
          input: { need: 'need', budget: '5000', timeline: 'now' },
        })
      ).status,
    ).toBe('failed');
    const ended = await runtime.endSession(session.id);
    expect(ended.outcome?.resolved).toBe(false);
    expect(ended.status).toBe('completed');
  });
  it('resolves relative dates in calendar timezone and only offers requested afternoon slots', async () => {
    expect(requestedBusinessDate('tomorrow', 'Asia/Yerevan', new Date('2026-09-16T22:00:00Z'))).toBe(
      '2026-09-18',
    );
    expect(requestedBusinessDate('Friday', 'America/Los_Angeles', new Date('2026-09-18T01:00:00Z'))).toBe(
      '2026-09-18',
    );
    const { runtime, repo } = fixture();
    const session = await runtime.startSession('appointment-booking');
    const reply = await runtime.message(session.id, 'Friday afternoon please');
    expect(reply.text).toContain('14:00');
    expect(reply.text).not.toContain('10:00');
    expect((await repo.getSession(session.id)).snapshot.business?.offeredSlots).toHaveLength(1);
  });

  it('persists a confirmed Google event and rejects attempts to book a second different appointment', async () => {
    const { runtime, actions, repo } = fixture();
    const session = await runtime.startSession('appointment-booking');
    await runtime.message(session.id, 'Show available times');
    calendarMock.book.mockResolvedValueOnce({
      provider: 'google',
      eventId: 'google-event-1',
      status: 'confirmed',
      start: '2030-09-16T10:00:00.000Z',
      end: '2030-09-16T10:30:00.000Z',
      htmlLink: 'https://calendar.google.com/calendar/event?eid=demo',
    } as any);
    expect((await runtime.message(session.id, 'Book option 1')).text).toContain('Calendar event confirmed');
    expect(actions[0].input).toMatchObject({
      provider: 'google',
      eventId: 'google-event-1',
      status: 'confirmed',
      htmlLink: expect.stringContaining('calendar.google.com'),
    });
    expect((await repo.getSession(session.id)).outcome?.resolved).toBe(true);
    expect(calendarMock.book).toHaveBeenLastCalledWith(
      expect.objectContaining({ bookingKey: 'appointment', sessionId: session.id }),
    );
    const result = await runtime.executeTool(session.id, {
      id: randomUUID(),
      name: 'book_appointment',
      input: {
        serviceId: 'consultation',
        start: '2030-09-16T14:00:00.000Z',
        end: '2030-09-16T14:30:00.000Z',
      },
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('different appointment');
  });

  it('recovers the same external booking after a local persistence failure and availability refresh', async () => {
    const { runtime, repo, actions } = fixture();
    const session = await runtime.startSession('appointment-booking');
    await runtime.message(session.id, 'Show available times');
    const save = repo.createAction;
    repo.createAction = vi
      .fn()
      .mockRejectedValueOnce(new Error('Temporary persistence failure'))
      .mockImplementation(save);
    await runtime.message(session.id, 'Book option 1');
    expect(actions).toHaveLength(0);
    const latest = await repo.getSession(session.id);
    latest.snapshot.business!.offeredSlots = [];
    const retry = await runtime.executeTool(session.id, {
      id: randomUUID(),
      name: 'book_appointment',
      input: {
        serviceId: 'consultation',
        start: '2030-09-16T10:00:00.000Z',
        end: '2030-09-16T10:30:00.000Z',
      },
    });
    expect(retry.status).toBe('completed');
    expect(actions).toHaveLength(1);
  });
  it('does not transfer a lead that merely describes replacing human operators', async () => {
    const { runtime, repo } = fixture();
    const session = await runtime.startSession('lead-qualification');
    await runtime.message(
      session.id,
      'Need: replace human operators for routine calls; Budget: $5000; Timeline: next month',
    );
    expect((await repo.getSession(session.id)).handoff).toBeUndefined();
    expect((await repo.getSession(session.id)).outcome?.intent).toBe('lead_qualification');
  });
});
