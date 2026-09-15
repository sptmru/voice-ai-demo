import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  scenarioIds,
  type AgentEvent,
  type MemoryItem,
  type PendingConfirmation,
  type Repository,
  type RetrievalService,
  type SupportSession,
  type Ticket,
} from '../packages/core/src/domain.js';
import { demoCustomer, scenarioSnapshot } from '../packages/db/src/fixtures.js';
import { SupportRuntime } from '../packages/core/src/runtime.js';
import { sanitize, ToolExecutor } from '../packages/core/src/executor.js';
import { createTools } from '../packages/core/src/tools.js';

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

describe('provider-independent tool executor', () => {
  it('has all 12 PDF tools, provider-neutral JSON schemas and a human-only boundary', () => {
    const tools = createTools();
    expect(tools).toHaveLength(15);
    for (const tool of tools) expect(tool.jsonSchema.type).toBe('object');
    expect(tools.find((t) => t.name === 'adjust_account_balance')?.permission).toBe('human-only');
  });
  it('rejects injected identity, invalid limits, foreign calls, and model self-approval', async () => {
    const { runtime } = fixture();
    const session = await runtime.startSession('carrier-incident');
    for (const [name, input] of [
      ['get_customer', { customerId: 'another' }],
      ['get_recent_calls', { limit: 100 }],
      ['get_call_details', { callId: 'foreign' }],
      ['reset_trunk_credentials', { reason: 'reset', approved: true }],
      ['adjust_account_balance', { reason: 'credit' }],
    ] as const) {
      const result = await runtime.executeTool(session.id, { id: randomUUID(), name, input });
      expect(result.status).toBe('failed');
    }
  });
  it('replays a ticket request safely across executor instances and refuses changed arguments', async () => {
    const { runtime, repo, rag } = fixture();
    const session = await runtime.startSession('carrier-incident');
    const call = {
      id: 'same-call',
      name: 'create_support_ticket',
      input: { subject: 'SIP failure', description: 'Observed SIP 403', severity: 'high' },
    };
    const [first, second] = await Promise.all([
      runtime.executeTool(session.id, call),
      runtime.executeTool(session.id, call),
    ]);
    expect(first).toEqual(second);
    expect(repo.createTicket).toHaveBeenCalledTimes(1);
    expect(await new ToolExecutor(repo, rag).execute(session.id, call)).toEqual(first);
    expect(
      (await runtime.executeTool(session.id, { ...call, input: { ...call.input, subject: 'different' } }))
        .status,
    ).toBe('failed');
    expect(repo.createTicket).toHaveBeenCalledTimes(1);
  });
  it('approval is customer-session-bound, single-use and required before a mutation', async () => {
    const { runtime, repo } = fixture();
    const session = await runtime.startSession('invalid-credentials');
    const other = await runtime.startSession('invalid-credentials');
    const result = await runtime.executeTool(session.id, {
      id: 'reset',
      name: 'reset_trunk_credentials',
      input: { reason: 'Invalid auth verified' },
    });
    expect(result.status).toBe('pending-confirmation');
    expect(repo.createAction).not.toHaveBeenCalled();
    await expect(runtime.confirm(other.id, result.confirmationId!, true)).rejects.toThrow('not found');
    await runtime.message(session.id, 'yes');
    expect(repo.createAction).not.toHaveBeenCalled();
    expect((await runtime.confirm(session.id, result.confirmationId!, true)).status).toBe('completed');
    await expect(runtime.confirm(session.id, result.confirmationId!, true)).rejects.toThrow('consumed');
    expect(repo.createAction).toHaveBeenCalledTimes(1);
  });
  it('rejected and expired approvals cannot execute, including simultaneous confirmation', async () => {
    const { runtime, repo, confirmations } = fixture();
    const session = await runtime.startSession('invalid-credentials');
    const first = await runtime.executeTool(session.id, {
      id: 'reset-1',
      name: 'reset_trunk_credentials',
      input: { reason: 'Invalid auth' },
    });
    await runtime.confirm(session.id, first.confirmationId!, false);
    const second = await runtime.executeTool(session.id, {
      id: 'reset-2',
      name: 'reset_trunk_credentials',
      input: { reason: 'Invalid auth' },
    });
    confirmations[1].expiresAt = new Date(0).toISOString();
    await expect(runtime.confirm(session.id, second.confirmationId!, true)).rejects.toThrow('expired');
    expect(repo.createAction).not.toHaveBeenCalled();
    const third = await runtime.executeTool(session.id, {
      id: 'reset-3',
      name: 'reset_trunk_credentials',
      input: { reason: 'Invalid auth' },
    });
    const results = await Promise.allSettled([
      runtime.confirm(session.id, third.confirmationId!, true),
      runtime.confirm(session.id, third.confirmationId!, true),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(repo.createAction).toHaveBeenCalledTimes(1);
  });
  it('redacts secret fields while preserving diagnostic booleans', () => {
    expect(
      sanitize({
        password: 'secret',
        credentialsValid: false,
        nested: { apiKey: 'abc', chainOfThought: 'hidden' },
        text: 'Bearer abc123',
      }),
    ).toEqual({
      password: '[REDACTED]',
      credentialsValid: false,
      nested: { apiKey: '[REDACTED]', chainOfThought: '[REDACTED]' },
      text: 'Bearer [REDACTED]',
    });
  });
  it('redacts validated free text before tickets, pending approvals, mutations and outcomes are stored', async () => {
    const { runtime, tickets, confirmations, actions, sessions, events, memories } = fixture();
    const session = await runtime.startSession('invalid-credentials');
    const secret = 'password=unit-sensitive-sentinel';
    await runtime.executeTool(session.id, {
      id: 'ticket-redaction',
      name: 'create_support_ticket',
      input: { subject: 'Authentication failure', description: secret, severity: 'high' },
    });
    await runtime.executeTool(session.id, {
      id: 'followup-redaction',
      name: 'send_followup',
      input: { message: secret },
    });
    const reset = await runtime.executeTool(session.id, {
      id: 'sk-provider-id-1234567890',
      name: 'reset_trunk_credentials',
      input: { reason: secret },
    });
    expect(JSON.stringify(confirmations)).not.toContain('unit-sensitive-sentinel');
    await runtime.confirm(session.id, reset.confirmationId!, true);
    await runtime.executeTool(session.id, {
      id: 'outcome-redaction',
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
    for (const stored of [tickets, confirmations, actions, [...sessions.values()], events, memories])
      expect(JSON.stringify(stored)).not.toContain('unit-sensitive-sentinel');
    expect(events.some((event) => event.correlationId === 'sk-provider-id-1234567890')).toBe(true);
    expect(sanitize({ callId: 'sk-provider-id-1234567890' })).toEqual({
      callId: 'sk-provider-id-1234567890',
    });
  });
  it('does not allow fabricated customer, ticket or action references in outcome tool input', async () => {
    const { runtime } = fixture();
    const session = await runtime.startSession('unknown');
    const result = await runtime.executeTool(session.id, {
      id: 'outcome',
      name: 'complete_support_case',
      input: {
        customer: 'Other customer',
        ticketId: 'FAKE',
        actions: ['made up'],
        intent: 'technical_support',
        severity: 'high',
        product: 'SIP',
        issue: 'failure',
        diagnosis: 'unknown',
        resolved: false,
        nextAction: 'escalate',
      },
    });
    expect(result.status).toBe('failed');
  });
  it('does not let the model claim recovery when the most recent call failed', async () => {
    const { runtime } = fixture();
    const session = await runtime.startSession('carrier-incident');
    const result = await runtime.executeTool(session.id, {
      id: 'false-recovery',
      name: 'complete_support_case',
      input: {
        intent: 'technical_support',
        severity: 'high',
        product: 'SIP',
        issue: 'failure',
        diagnosis: 'It should work',
        resolved: true,
        nextAction: 'close',
      },
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('successful latest test call');
  });
});

describe('deterministic evidence-driven runtime', () => {
  it.each(scenarioIds)(
    'diagnoses %s using operational tools and persists a validated outcome',
    async (scenario) => {
      const { runtime, repo, rag, events } = fixture();
      const session = await runtime.startSession(scenario);
      const response = await runtime.message(session.id, 'Please investigate and create a support ticket.');
      const expected = {
        'carrier-incident': 'carrier degradation',
        'caller-id': 'caller ID',
        'international-disabled': 'calling restriction',
        'invalid-credentials': 'authentication',
        'account-balance': 'Account restriction',
        'number-routing': 'routing',
        unknown: 'Unexplained',
      };
      expect(response.outcome?.issue).toContain(expected[scenario]);
      expect(response.outcome?.resolved).toBe(false);
      expect(response.outcome?.ticketId).toBe('SUP-1');
      expect(rag.search).toHaveBeenCalledOnce();
      expect(await repo.getTickets(session.id)).toHaveLength(1);
      expect(events.filter((e) => e.type === 'tool.completed')).toHaveLength(
        scenario === 'unknown' || scenario === 'number-routing' ? 11 : 10,
      );
      expect(events.some((e) => e.type === 'retrieval.completed' && Array.isArray(e.payload.chunks))).toBe(
        true,
      );
      expect((await repo.getSession(session.id)).status).toBe('active');
    },
  );
  it('branches on returned evidence rather than scenario id', async () => {
    const { runtime, repo } = fixture();
    const session = await runtime.startSession('carrier-incident');
    session.snapshot.account.internationalEnabled = false;
    await repo.updateSession(session.id, { snapshot: session.snapshot });
    const response = await runtime.message(session.id, 'Investigate');
    expect(response.outcome?.issue).toBe('Destination calling restriction');
  });
  it('follow-up turns reuse diagnosis, keep one ticket and save selective memory only on end', async () => {
    const { runtime, repo, rag, memories, actions } = fixture();
    const session = await runtime.startSession('carrier-incident');
    await runtime.message(session.id, 'Investigate and open a ticket');
    await runtime.message(session.id, 'What is my ticket?');
    await runtime.message(session.id, 'Send a follow-up email');
    expect(actions[0].kind).toBe('followup');
    expect(rag.search).toHaveBeenCalledOnce();
    expect(await repo.getTickets(session.id)).toHaveLength(1);
    expect(memories).toHaveLength(0);
    const ended = await runtime.endSession(session.id);
    expect(ended.status).toBe('completed');
    expect(memories.map((m) => m.kind)).toEqual(['summary', 'case']);
    await runtime.endSession(session.id);
    expect(memories).toHaveLength(2);
  });
  it('refreshes an existing outcome after voice tools, approval and finalization', async () => {
    const { runtime, repo } = fixture();
    const session = await runtime.startSession('invalid-credentials');
    await runtime.message(session.id, 'Investigate');
    const ticket = await runtime.executeTool(session.id, {
      id: 'later-ticket',
      name: 'create_support_ticket',
      input: { subject: 'Follow-up investigation', description: 'Needs review', severity: 'high' },
    });
    const followup = await runtime.executeTool(session.id, {
      id: 'later-followup',
      name: 'send_followup',
      input: { message: 'We will review the evidence' },
    });
    expect((await repo.getSession(session.id)).outcome?.ticketId).toBe((ticket.result as Ticket).id);
    expect((await repo.getSession(session.id)).outcome?.actions).toContain(
      `followup:${(followup.result as { id: string }).id}`,
    );
    const reset = await runtime.executeTool(session.id, {
      id: 'later-reset',
      name: 'reset_trunk_credentials',
      input: { reason: 'Confirmed authentication failure' },
    });
    const approved = await runtime.confirm(session.id, reset.confirmationId!, true);
    expect((await repo.getSession(session.id)).outcome?.actions).toContain(
      `credential-reset:${(approved.result as { id: string }).id}`,
    );
    const ended = await runtime.endSession(session.id);
    expect(ended.outcome?.actions).toContain('tool:reset_trunk_credentials');
    expect(ended.outcome?.resolved).toBe(false);
  });
  it('reports missing voice workflow tools and finalizes a partial investigation without inventing a cause', async () => {
    const { runtime, repo, memories } = fixture();
    const session = await runtime.startSession('carrier-incident');
    expect(await runtime.ensureVoiceOutcome(session.id)).toEqual([]);
    await runtime.executeTool(session.id, { id: 'voice-account', name: 'get_account', input: {} });
    expect(await runtime.ensureVoiceOutcome(session.id)).toEqual([
      'search_knowledge_base',
      'complete_support_case',
    ]);
    await runtime.executeTool(session.id, {
      id: 'voice-search',
      name: 'search_knowledge_base',
      input: { query: 'SIP 403 UK' },
    });
    expect(await runtime.ensureVoiceOutcome(session.id)).toEqual(['complete_support_case']);
    const ticket = await runtime.executeTool(session.id, {
      id: 'voice-ticket',
      name: 'create_support_ticket',
      input: {
        subject: 'Calls need investigation',
        description: 'Unfinished diagnosis',
        severity: 'critical',
      },
    });
    const ended = await runtime.endSession(session.id);
    expect(ended.outcome).toMatchObject({
      resolved: false,
      severity: 'critical',
      ticketId: (ticket.result as Ticket).id,
    });
    expect(ended.outcome?.diagnosis).toContain('before a validated diagnosis');
    expect(ended.outcome?.diagnosis).not.toContain('carrier degradation');
    expect(ended.outcome?.nextAction).toContain('human engineer');
    expect(ended.outcome?.actions).toContain('tool:get_account');
    expect(memories.map((memory) => memory.kind)).toEqual(['summary', 'case']);
    expect(await runtime.ensureVoiceOutcome(session.id)).toEqual([]);
    expect((await repo.getSession(session.id)).status).toBe('completed');
  });
  it('finalizes an untouched session as incomplete and remains idempotent', async () => {
    const { runtime, memories, events } = fixture();
    const session = await runtime.startSession('carrier-incident');
    const ended = await runtime.endSession(session.id);
    expect(ended.outcome).toMatchObject({
      issue: 'Incomplete support investigation',
      severity: 'low',
      resolved: false,
      ticketId: null,
    });
    expect(ended.outcome?.diagnosis).toContain('No completed diagnostic checks');
    const count = events.length;
    await runtime.endSession(session.id);
    expect(events).toHaveLength(count);
    expect(memories).toHaveLength(2);
  });
  it('requires call evidence before a voice call-failure investigation is considered complete', async () => {
    const { runtime, repo } = fixture();
    const session = await runtime.startSession('carrier-incident');
    await repo.appendEvent(session.id, 'transcript', {
      role: 'user',
      text: 'UK outbound calls fail with SIP 403',
    });
    await runtime.executeTool(session.id, { id: 'incident-only', name: 'get_service_incidents', input: {} });
    const missing = await runtime.ensureVoiceOutcome(session.id);
    expect(missing).toContain('get_recent_calls');
    expect(missing).toContain('get_call_details');
    expect(missing).toContain('check_number_configuration');
    expect(missing).toContain('search_knowledge_base');
    expect(missing.at(-1)).toBe('complete_support_case');
    expect(missing).not.toContain('get_service_incidents');
  });
});
