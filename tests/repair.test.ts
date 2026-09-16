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
import { scenarios } from '../packages/core/src/domain.js';
import { buildScenarioPrompt } from '../packages/core/src/prompt.js';
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

describe('appliance repair conversations', () => {
  it('keeps advice grounded, passes conversation context, and does not claim repair success', async () => {
    const { runtime, rag, repo, events } = fixture();
    rag.retrieve = vi.fn(async ({ query }) => ({
      status: 'supported' as const,
      query,
      rewrittenQuery: query,
      chunks: [
        {
          chunkId: 'warranty',
          documentId: 'policy',
          document: 'Repair warranty',
          section: 'Warranty terms',
          content: 'Warranty covers 90 calendar days.',
          source: 'repair/warranty.md',
          type: 'markdown',
          semanticScore: 0.9,
          lexicalScore: 0.4,
          combinedScore: 0.04,
        },
      ],
      reason: 'Supported by active policy',
    }));
    const session = await runtime.startSession('repair-advice');
    await runtime.message(session.id, 'Стиральная машина Relay Wash W100 не сливает воду');
    const reply = await runtime.message(session.id, 'А какая гарантия?');
    expect(reply.text).toContain('Warranty covers 90 calendar days');
    expect(reply.text).toContain('"Repair warranty"');
    expect(rag.retrieve).toHaveBeenLastCalledWith(
      expect.objectContaining({
        query: 'А какая гарантия?',
        domain: 'repair',
        context: expect.objectContaining({
          appliance: 'washing-machine',
          model: 'W100',
          previousQuery: 'Стиральная машина Relay Wash W100 не сливает воду',
        }),
      }),
    );
    expect((await repo.getSession(session.id)).outcome).toMatchObject({
      intent: 'repair_support',
      resolved: false,
    });
    expect(events.filter((e) => e.type === 'retrieval.completed').at(-1)?.payload.status).toBe('supported');
  });
  it.each(['insufficient', 'conflict', 'clarify'] as const)(
    'does not quote unsupported chunks when retrieval is %s',
    async (status) => {
      const { runtime, rag } = fixture();
      rag.retrieve = vi.fn(async ({ query }) => ({
        status,
        query,
        rewrittenQuery: query,
        chunks: [],
        reason: 'No matching active evidence',
      }));
      const session = await runtime.startSession('repair-advice');
      const reply = await runtime.message(session.id, 'Гарантия на неизвестную модель?');
      expect(reply.text).not.toContain('According to');
      expect(reply.text).toMatch(/not provide enough evidence|conflicting policies|Please specify/);
    },
  );
  it('fails closed when evidence-aware retrieval is unavailable', async () => {
    const { runtime, rag } = fixture();
    const session = await runtime.startSession('repair-advice');
    expect((await runtime.message(session.id, 'Гарантия на ремонт?')).text).toContain(
      'not provide enough evidence',
    );
    expect(rag.search).not.toHaveBeenCalled();
  });
  it('collects actual appliance and symptom before booking an offered slot once', async () => {
    const { runtime, actions, repo } = fixture();
    const session = await runtime.startSession('repair-booking');
    expect((await runtime.message(session.id, 'Хочу записаться')).text).toContain('Which appliance');
    expect((await runtime.message(session.id, 'Стиральная машина W100')).text).toContain('What happened');
    expect((await runtime.message(session.id, 'Не сливает воду')).text).toContain('Local demo availability');
    expect(actions).toHaveLength(0);
    expect((await runtime.message(session.id, 'Выбираю вариант 1')).text).toContain(
      'Local demo booking saved',
    );
    expect(actions).toHaveLength(1);
    expect((await repo.getSession(session.id)).outcome).toMatchObject({
      intent: 'repair_support',
      resolved: true,
    });
    expect(calendarMock.book).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: expect.stringContaining('Не сливает воду') }),
    );
    await runtime.message(session.id, 'Выбираю вариант 1');
    expect(actions).toHaveLength(1);
  });
  it('can book from an advice session but never use an unoffered slot', async () => {
    const { runtime, actions } = fixture();
    const session = await runtime.startSession('repair-advice');
    expect((await runtime.message(session.id, 'Выбираю вариант 1')).text).toContain('Which appliance');
    await runtime.message(session.id, 'Хочу записаться: холодильник Cool C100 не охлаждает');
    await runtime.message(session.id, 'Выбираю вариант 1');
    expect(actions[0]).toMatchObject({ kind: 'appointment', input: { serviceId: 'workshop-diagnosis' } });
  });
  it('requires address and Yerevan before a home visit', async () => {
    const { runtime, actions, repo } = fixture();
    const session = await runtime.startSession('repair-booking');
    expect((await runtime.message(session.id, 'Нужен выезд: холодильник C100 не охлаждает')).text).toContain(
      'only within Yerevan',
    );
    expect(actions).toHaveLength(0);
    await runtime.message(session.id, 'Адрес: Ереван, улица Туманяна 10, квартира 2');
    await runtime.message(session.id, 'Выбираю вариант 1');
    expect(actions[0]).toMatchObject({ kind: 'appointment', input: { serviceId: 'home-diagnosis' } });
    expect((await repo.getSession(session.id)).snapshot.repair?.address).toContain('Туманяна');
  });
  it('checks job ownership and keeps status unresolved with no invented ETA', async () => {
    const { runtime, repo } = fixture();
    const session = await runtime.startSession('repair-status');
    const reply = await runtime.message(session.id, 'Что с REP-1042?');
    expect(reply.text).toContain('awaiting quote approval');
    expect(reply.text).toContain('No confirmed completion date');
    expect((await repo.getSession(session.id)).outcome?.resolved).toBe(false);
    session.snapshot.repair!.jobs[0].customerId = 'someone-else';
    expect((await runtime.message(session.id, 'REP-1042')).text).toContain('not found for this customer');
  });
  it('uses authoritative prices and makes no inventory promise', async () => {
    const { runtime, rag } = fixture();
    const session = await runtime.startSession('repair-advice');
    const reply = await runtime.message(session.id, 'Сколько стоит диагностика?');
    expect(reply.text).toContain('5000 AMD');
    expect(reply.text).toContain('8000 AMD');
    expect(reply.text).toContain('Live parts availability is not connected');
    expect(rag.search).not.toHaveBeenCalled();
  });
  it('blocks telecom tools and false repair completion, ending without SIP diagnostics', async () => {
    const { runtime } = fixture();
    const session = await runtime.startSession('repair-advice');
    expect(
      (await runtime.executeTool(session.id, { id: randomUUID(), name: 'get_recent_calls', input: {} }))
        .status,
    ).toBe('failed');
    expect(
      (
        await runtime.executeTool(session.id, {
          id: randomUUID(),
          name: 'complete_support_case',
          input: {
            intent: 'repair_support',
            severity: 'low',
            product: 'Repair',
            issue: 'Broken',
            diagnosis: 'Repaired',
            resolved: true,
            nextAction: 'Use appliance',
          },
        })
      ).status,
    ).toBe('failed');
    const ended = await runtime.endSession(session.id);
    expect(ended.outcome).toMatchObject({ intent: 'repair_support', resolved: false });
    expect(ended.outcome?.diagnosis).not.toContain('SIP');
  });
  it('hands off an unsafe symptom and silences further automation', async () => {
    const { runtime, repo } = fixture();
    const session = await runtime.startSession('repair-advice');
    expect((await runtime.message(session.id, 'Из стиральной машины идёт дым')).text).toContain(
      'Stop using the appliance',
    );
    expect((await repo.getSession(session.id)).handoff?.status).toBe('waiting');
    expect((await runtime.message(session.id, 'Как снять корпус?')).text).toBe('');
  });
  it('clears the previous appliance model for a new appliance', async () => {
    const { runtime, repo } = fixture();
    const session = await runtime.startSession('repair-advice');
    await runtime.message(session.id, 'Стиральная машина W100 не сливает воду');
    await runtime.message(session.id, 'А у меня еще холодильник');
    expect((await repo.getSession(session.id)).snapshot.repair).toMatchObject({ appliance: 'refrigerator' });
    expect((await repo.getSession(session.id)).snapshot.repair?.model).toBeUndefined();
    expect((await repo.getSession(session.id)).snapshot.repair?.issue).toBeUndefined();
  });
  it('does not treat an address outside Yerevan as Yerevan', async () => {
    const { runtime, repo, actions } = fixture();
    const session = await runtime.startSession('repair-booking');
    await runtime.message(session.id, 'Нужен выезд: холодильник C100 не охлаждает');
    expect((await runtime.message(session.id, 'Адрес: Гюмри, улица Ереванская 10')).text).toContain(
      'only within Yerevan',
    );
    expect((await repo.getSession(session.id)).snapshot.repair?.region).toBeUndefined();
    expect(actions).toHaveLength(0);
  });
  it('never records a repaired appliance merely because an appointment exists', async () => {
    const { runtime, repo } = fixture();
    const session = await runtime.startSession('repair-booking');
    await runtime.message(session.id, 'Холодильник C100 не охлаждает, хочу записаться');
    await runtime.message(session.id, 'Выбираю вариант 1');
    const outcome = (await repo.getSession(session.id)).outcome!;
    expect(outcome.diagnosis).toContain('Appliance repair is not confirmed');
    const result = await runtime.executeTool(session.id, {
      id: randomUUID(),
      name: 'complete_support_case',
      input: {
        intent: 'repair_support',
        severity: 'low',
        product: 'Repair',
        issue: 'Broken appliance',
        diagnosis: 'The appliance was successfully repaired',
        resolved: true,
        nextAction: 'Use normally',
      },
    });
    expect(result.status).toBe('completed');
    expect((await repo.getSession(session.id)).outcome?.diagnosis).toContain(
      'Appliance repair is not confirmed',
    );
  });
  it('does not route a repair duration question into the price tool', async () => {
    const { runtime, rag, events } = fixture();
    rag.retrieve = vi.fn(async ({ query }) => ({
      status: 'insufficient' as const,
      query,
      rewrittenQuery: query,
      chunks: [],
      reason: 'No fixed timing guarantee',
    }));
    const session = await runtime.startSession('repair-advice');
    await runtime.message(session.id, 'Сколько ремонт займет времени?');
    expect(rag.retrieve).toHaveBeenCalled();
    expect(events.some((e) => e.type === 'tool.completed' && e.payload.name === 'get_repair_catalog')).toBe(
      false,
    );
  });
  it('clears a previous symptom and query when switching models', async () => {
    const { runtime, rag, repo } = fixture();
    rag.retrieve = vi.fn(async ({ query }) => ({
      status: 'insufficient' as const,
      query,
      rewrittenQuery: query,
      chunks: [],
      reason: 'Insufficient',
    }));
    const session = await runtime.startSession('repair-advice');
    await runtime.message(session.id, 'Relay Wash W100 не сливает воду');
    await runtime.message(session.id, 'А теперь Relay Wash W200');
    expect(rag.retrieve).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ model: 'W200', previousQuery: undefined }),
      }),
    );
    expect((await repo.getSession(session.id)).snapshot.repair?.issue).toBeUndefined();
  });
  it('prefers one English passage without a duplicate translation even for a Russian query', async () => {
    const { runtime, rag } = fixture();
    const base = {
      chunkId: '1',
      documentId: 'same',
      document: 'Warranty',
      source: 'repair/warranty.md',
      type: 'markdown',
      semanticScore: 0.9,
      lexicalScore: 0.1,
      combinedScore: 0.04,
    };
    rag.retrieve = vi.fn(async ({ query }) => ({
      status: 'supported' as const,
      query,
      rewrittenQuery: query,
      reason: 'Active policy',
      chunks: [
        { ...base, section: 'Warranty', content: 'Warranty is 90 days.' },
        { ...base, chunkId: '2', section: 'Гарантия', content: 'Гарантия 90 дней.' },
      ],
    }));
    const session = await runtime.startSession('repair-advice');
    const reply = await runtime.message(session.id, 'А гарантия?');
    expect(reply.text).not.toContain('Гарантия 90 дней.');
    expect(reply.text).toContain('Warranty is 90 days.');
  });
  it('runs the English guided booking prompts and saves an English summary', async () => {
    const { runtime, repo, actions } = fixture();
    const scenario = scenarios.find((s) => s.id === 'repair-booking')!;
    const session = await runtime.startSession(scenario.id);
    expect(scenario.label).toBe('Book a repair');
    expect((await runtime.message(session.id, scenario.prompt)).text).toContain('Local demo availability');
    expect((await runtime.message(session.id, 'Show available times')).text).toContain('Choose option 1');
    expect((await runtime.message(session.id, 'Choose option 1')).text).toContain('Local demo booking saved');
    expect(actions).toHaveLength(1);
    expect((await repo.getSession(session.id)).outcome?.diagnosis).toContain(
      'Appliance repair is not confirmed',
    );
    expect(buildScenarioPrompt(session)).toContain('Speak English by default');
    expect(buildScenarioPrompt(session)).not.toContain('Russian-first');
  });
  it('runs the English advice, price and status prompts without Russian generated text', async () => {
    const { runtime, rag } = fixture();
    rag.retrieve = vi.fn(async ({ query }) => ({
      status: 'insufficient' as const,
      query,
      rewrittenQuery: query,
      chunks: [],
      reason: 'No evidence',
    }));
    const scenario = scenarios.find((s) => s.id === 'repair-advice')!;
    const session = await runtime.startSession(scenario.id);
    const advice = await runtime.message(session.id, scenario.prompt);
    expect(rag.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ model: 'W100', appliance: 'washing-machine' }),
      }),
    );
    expect(advice.text).toContain('not provide enough evidence');
    expect((await runtime.message(session.id, 'How much does diagnosis cost?')).text).toContain(
      'Relay Workshop demo prices',
    );
    expect((await runtime.message(session.id, 'Check REP-1042')).text).toContain('awaiting quote approval');
    expect((await runtime.message(session.id, 'Talk to an operator')).text).toContain('operator queue');
  });
});
