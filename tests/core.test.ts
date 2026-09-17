import { z } from 'zod';
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
  const runtime = new SupportRuntime(repo, rag);
  runtime.executor.tools.push({
    name: 'test_sensitive_action',
    description: 'Synthetic approval test',
    permission: 'sensitive-write',
    inputSchema: z.object({ reason: z.string() }).strict(),
    jsonSchema: {},
    execute: (input, c) => c.repo.createAction(c.session.id, 'test-action', input, c.callId),
  });
  return {
    repo,
    rag,
    sessions,
    events,
    tickets,
    confirmations,
    actions,
    memories,
    runtime,
  };
}

describe('provider-independent tool executor', () => {
  it('serializes confirmation with human handoff while unrelated sessions remain available', async () => {
    const { runtime, repo, actions } = fixture();
    const session = await runtime.startSession('repair-status');
    const other = await runtime.startSession('repair-advice');
    await runtime.message(session.id, 'Investigate failing calls');
    const pending = await runtime.executeTool(session.id, {
      id: randomUUID(),
      name: 'test_sensitive_action',
      input: { reason: 'Customer approved rotation' },
    });
    let release!: () => void;
    let entered!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolveConfirmation = repo.resolveConfirmation;
    repo.resolveConfirmation = async (...args) => {
      entered();
      await releaseGate;
      return resolveConfirmation(...args);
    };
    const confirmed = runtime.confirm(session.id, pending.confirmationId!, true);
    await enteredGate;
    const transfer = runtime.executeTool(session.id, {
      id: randomUUID(),
      name: 'request_human_handoff',
      input: { reason: 'Please connect an operator' },
    });
    expect(
      (await runtime.executeTool(other.id, { id: randomUUID(), name: 'get_customer', input: {} })).status,
    ).toBe('completed');
    expect((await repo.getSession(session.id)).handoff).toBeUndefined();
    expect(actions).toHaveLength(0);
    release();
    expect((await confirmed).status).toBe('completed');
    expect((await transfer).status).toBe('completed');
    expect(actions.filter((action) => action.kind === 'test-action')).toHaveLength(1);
    expect((await repo.getSession(session.id)).handoff?.status).toBe('waiting');
    expect(
      (
        await runtime.executeTool(session.id, {
          id: randomUUID(),
          name: 'test_sensitive_action',
          input: { reason: 'Try again' },
        })
      ).status,
    ).toBe('failed');
    expect(actions.filter((action) => action.kind === 'test-action')).toHaveLength(1);
  });

  it('recovers its session queue after a rejected confirmation', async () => {
    const { runtime } = fixture();
    const session = await runtime.startSession('repair-advice');
    await expect(runtime.confirm(session.id, 'missing-confirmation', true)).rejects.toThrow(
      'Confirmation not found',
    );
    expect(
      (await runtime.executeTool(session.id, { id: randomUUID(), name: 'get_customer', input: {} })).status,
    ).toBe('completed');
  });

  it('has workshop tools, provider-neutral JSON schemas and approval boundaries', () => {
    const tools = createTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'get_customer',
        'complete_support_case',
        'book_appointment',
        'save_lead',
        'request_delivery_change',
        'request_human_handoff',
      ]),
    );
    for (const tool of tools) expect(tool.jsonSchema.type).toBe('object');
    expect(tools.find((t) => t.name === 'approve_repair_quote')?.permission).toBe('sensitive-write');
  });
  it('rejects injected identity, invalid limits, foreign calls, and model self-approval', async () => {
    const { runtime } = fixture();
    const session = await runtime.startSession('repair-advice');
    for (const [name, input] of [
      ['get_customer', { customerId: 'another' }],
      ['get_recent_calls', { limit: 100 }],
      ['get_call_details', { callId: 'foreign' }],
      ['test_sensitive_action', { reason: 'reset', approved: true }],
      ['adjust_account_balance', { reason: 'credit' }],
    ] as const) {
      const result = await runtime.executeTool(session.id, { id: randomUUID(), name, input });
      expect(result.status).toBe('failed');
    }
  });
  it('replays a ticket request safely across executor instances and refuses changed arguments', async () => {
    const { runtime, repo, rag } = fixture();
    const session = await runtime.startSession('repair-advice');
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
    const session = await runtime.startSession('repair-status');
    const other = await runtime.startSession('repair-status');
    const result = await runtime.executeTool(session.id, {
      id: 'reset',
      name: 'test_sensitive_action',
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
    const session = await runtime.startSession('repair-status');
    const first = await runtime.executeTool(session.id, {
      id: 'reset-1',
      name: 'test_sensitive_action',
      input: { reason: 'Invalid auth' },
    });
    await runtime.confirm(session.id, first.confirmationId!, false);
    const second = await runtime.executeTool(session.id, {
      id: 'reset-2',
      name: 'test_sensitive_action',
      input: { reason: 'Invalid auth' },
    });
    confirmations[1].expiresAt = new Date(0).toISOString();
    await expect(runtime.confirm(session.id, second.confirmationId!, true)).rejects.toThrow('expired');
    expect(repo.createAction).not.toHaveBeenCalled();
    const third = await runtime.executeTool(session.id, {
      id: 'reset-3',
      name: 'test_sensitive_action',
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
    const session = await runtime.startSession('repair-status');
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
      name: 'test_sensitive_action',
      input: { reason: secret },
    });
    expect(JSON.stringify(confirmations)).not.toContain('unit-sensitive-sentinel');
    await runtime.confirm(session.id, reset.confirmationId!, true);
    await runtime.executeTool(session.id, {
      id: 'outcome-redaction',
      name: 'complete_support_case',
      input: {
        intent: 'repair_support',
        severity: 'high',
        product: 'Relay Workshop',
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
    const session = await runtime.startSession('repair-advice');
    const result = await runtime.executeTool(session.id, {
      id: 'outcome',
      name: 'complete_support_case',
      input: {
        customer: 'Other customer',
        ticketId: 'FAKE',
        actions: ['made up'],
        intent: 'repair_support',
        severity: 'high',
        product: 'Relay Workshop',
        issue: 'failure',
        diagnosis: 'repair-advice',
        resolved: false,
        nextAction: 'escalate',
      },
    });
    expect(result.status).toBe('failed');
  });
  it('does not let the model claim resolution without a confirmed booking', async () => {
    const { runtime } = fixture();
    const session = await runtime.startSession('repair-advice');
    const result = await runtime.executeTool(session.id, {
      id: 'false-recovery',
      name: 'complete_support_case',
      input: {
        intent: 'repair_support',
        severity: 'high',
        product: 'Relay Workshop',
        issue: 'failure',
        diagnosis: 'It should work',
        resolved: true,
        nextAction: 'close',
      },
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('resolved');
  });
});
