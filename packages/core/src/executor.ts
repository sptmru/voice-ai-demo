import { createHash, randomUUID } from 'node:crypto';
import type { EmitEvent, Repository, RetrievalService } from './domain.js';
import { createTools, type ToolDefinition } from './tools.js';
import { sanitize } from './redaction.js';
export { sanitize } from './redaction.js';

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}
export interface ToolExecutionResult {
  id: string;
  name: string;
  status: 'completed' | 'pending-confirmation' | 'failed';
  result?: unknown;
  error?: string;
  confirmationId?: string;
}
export class ToolExecutor {
  readonly tools: ToolDefinition[];
  private inFlight = new Map<string, Promise<ToolExecutionResult>>();
  constructor(
    private repo: Repository,
    private rag: RetrievalService,
    private emitForSession?: (id: string) => EmitEvent,
    tools = createTools(),
  ) {
    this.tools = tools;
  }
  private emit(id: string): EmitEvent {
    const base =
      this.emitForSession?.(id) ??
      ((type, payload, duration, correlation) =>
        this.repo.appendEvent(id, type, payload, duration, correlation));
    return (type, payload, duration, correlation) =>
      base(type, sanitize(payload) as Record<string, unknown>, duration, correlation);
  }
  async execute(sessionId: string, call: ToolCall): Promise<ToolExecutionResult> {
    if (!call.id || call.id.length > 200) throw new Error('A bounded tool call ID is required');
    // IDs are scoped to a server-owned session and bound to exact requested arguments.
    const key = `${sessionId}:${call.id}`;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ name: call.name, input: call.input }))
      .digest('hex');
    if (this.inFlight.has(key)) {
      await this.inFlight.get(key);
      return this.execute(sessionId, call);
    }
    const work = this.run(sessionId, call, fingerprint);
    this.inFlight.set(key, work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(key);
    }
  }
  private async run(sessionId: string, call: ToolCall, fingerprint: string): Promise<ToolExecutionResult> {
    const emit = this.emit(sessionId);
    const start = Date.now();
    try {
      const session = await this.repo.getSession(sessionId);
      if (session.status !== 'active') throw new Error('Session has ended');
      const previous = (await this.repo.getEvents(sessionId)).filter((e) => e.correlationId === call.id);
      const requested = previous.find((e) => e.type === 'tool.started');
      if (requested && requested.payload.fingerprint !== fingerprint)
        throw new Error('Tool call ID was already used with different arguments');
      const done = previous.find((e) => e.type === 'tool.completed' || e.type === 'tool.failed');
      if (done) return done.payload.execution as ToolExecutionResult;
      const pending = previous.find((e) => e.type === 'confirmation.required');
      if (pending)
        return {
          id: call.id,
          name: call.name,
          status: 'pending-confirmation',
          confirmationId: String(pending.payload.confirmationId),
        };
      // A prior unfinished mutation has an ambiguous outcome: never blindly repeat it.
      if (requested)
        throw new Error(
          'Interrupted tool execution requires review; use a new request after checking records',
        );
      const tool = this.tools.find((t) => t.name === call.name);
      if (!tool) throw new Error(`Unknown tool: ${call.name}`);
      const input = tool.inputSchema.parse(sanitize(tool.inputSchema.parse(call.input)));
      await emit(
        'tool.started',
        { name: call.name, input, permission: tool.permission, fingerprint },
        undefined,
        call.id,
      );
      if (tool.permission === 'human-only')
        throw new Error('This action requires a human engineer and cannot be approved by the assistant');
      if (tool.permission === 'sensitive-write') {
        const pendingExisting = (await this.repo.getConfirmations(sessionId)).find(
          (c) =>
            c.toolName === tool.name &&
            c.status === 'pending' &&
            new Date(c.expiresAt).getTime() > Date.now(),
        );
        const confirmation =
          pendingExisting ?? (await this.repo.createConfirmation(sessionId, tool.name, input));
        await emit(
          'confirmation.required',
          { confirmationId: confirmation.id, toolName: tool.name, input, expiresAt: confirmation.expiresAt },
          undefined,
          call.id,
        );
        return {
          id: call.id,
          name: call.name,
          status: 'pending-confirmation',
          confirmationId: confirmation.id,
        };
      }
      const result = sanitize(
        await tool.execute(input, { session, repo: this.repo, rag: this.rag, emit, callId: call.id }),
      );
      const execution: ToolExecutionResult = { id: call.id, name: call.name, status: 'completed', result };
      await emit('tool.completed', { name: call.name, result, execution }, Date.now() - start, call.id);
      return execution;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool execution failed';
      const execution: ToolExecutionResult = {
        id: call.id,
        name: call.name,
        status: 'failed',
        error: String(sanitize(message)),
      };
      await emit(
        'tool.failed',
        { name: call.name, error: execution.error, execution },
        Date.now() - start,
        call.id,
      );
      return execution;
    }
  }
  /** Only the trusted HTTP confirmation route may call this method, never model tools. */
  async confirm(sessionId: string, id: string, approve: boolean): Promise<ToolExecutionResult> {
    const session = await this.repo.getSession(sessionId);
    if (session.status !== 'active') throw new Error('Session has ended');
    const emit = this.emit(sessionId);
    const confirmation = (await this.repo.getConfirmations(sessionId)).find((c) => c.id === id);
    if (!confirmation) throw new Error('Confirmation not found in this session');
    if (confirmation.status !== 'pending') throw new Error('Confirmation was already consumed');
    if (new Date(confirmation.expiresAt).getTime() <= Date.now()) throw new Error('Confirmation expired');
    const resolved = await this.repo.resolveConfirmation(sessionId, id, approve);
    await emit(
      'confirmation.resolved',
      { confirmationId: id, toolName: resolved.toolName, status: resolved.status },
      undefined,
      id,
    );
    if (!approve || resolved.status !== 'approved')
      return { id, name: resolved.toolName, status: 'failed', error: 'Action rejected' };
    const tool = this.tools.find((t) => t.name === resolved.toolName);
    if (!tool || tool.permission !== 'sensitive-write')
      throw new Error('Only sensitive actions may use approval cards');
    const callId = `confirmation:${id}`;
    const start = Date.now();
    await emit(
      'tool.started',
      { name: tool.name, input: resolved.input, permission: tool.permission, approvedBy: 'session-user' },
      undefined,
      callId,
    );
    try {
      const result = sanitize(
        await tool.execute(tool.inputSchema.parse(sanitize(resolved.input)), {
          session,
          repo: this.repo,
          rag: this.rag,
          emit,
          callId,
        }),
      );
      const execution: ToolExecutionResult = { id, name: tool.name, status: 'completed', result };
      await emit('tool.completed', { name: tool.name, result, execution }, Date.now() - start, callId);
      return execution;
    } catch (error) {
      const execution: ToolExecutionResult = {
        id,
        name: tool.name,
        status: 'failed',
        error: String(sanitize(error instanceof Error ? error.message : 'Confirmed action failed')),
      };
      await emit(
        'tool.failed',
        { name: tool.name, error: execution.error, execution },
        Date.now() - start,
        callId,
      );
      return execution;
    }
  }
}
export const newToolCall = (name: string, input: unknown = {}): ToolCall => ({
  id: randomUUID(),
  name,
  input,
});
