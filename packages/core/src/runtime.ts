import type { TextAgent } from './text-agent.js';
import { repairMessage } from './repair-runtime.js';
import { isRepairScenario } from './repair-tools.js';
import { businessMessage } from './business-runtime.js';
import { isBusinessScenario, businessIntent } from './business-tools.js';
import type { CallOutcome, EmitEvent, Repository, RetrievalService, ScenarioId } from './domain.js';
import { ToolExecutor, newToolCall, sanitize, type ToolCall } from './executor.js';

/** No-key mode: an evidence-driven diagnostic policy, deliberately not an LLM. */
export class SupportRuntime {
  readonly executor: ToolExecutor;
  private busy = new Set<string>();
  constructor(
    private repo: Repository,
    private rag: RetrievalService,
    private emitForSession?: (id: string) => EmitEvent,
    private textAgent?: TextAgent,
  ) {
    this.executor = new ToolExecutor(repo, rag, emitForSession);
  }
  private emit(id: string): EmitEvent {
    const base =
      this.emitForSession?.(id) ??
      ((type, payload, duration, correlation) =>
        this.repo.appendEvent(id, type, payload, duration, correlation));
    return (type, payload, duration, correlation) =>
      base(type, sanitize(payload) as Record<string, unknown>, duration, correlation);
  }
  async startSession(scenario: ScenarioId, mode: 'rehearsal' | 'live' = 'rehearsal') {
    const session = await this.repo.createSession(scenario, mode);
    const customer = await this.repo.getCustomer(session.customerId);
    await this.emit(session.id)('customer.identified', { customer });
    const memories = (await this.repo.getMemory(customer.id))
      .slice(0, 5)
      .map((m) => ({ ...m, content: m.content.slice(0, 1200) }));
    await this.emit(session.id)('memory.retrieved', { memories });
    await this.emit(session.id)('support.state', {
      state: 'ready',
      mode: this.textAgent ? 'generative' : 'deterministic',
      message: this.textAgent
        ? `Conversational text uses ${this.textAgent.provider}; actions use validated tools.`
        : 'No-key text mode uses a deterministic diagnostic policy and real local tools.',
    });
    return session;
  }
  async executeTool(sessionId: string, call: ToolCall) {
    const result = await this.executor.execute(sessionId, call);
    const permission = this.executor.tools.find((tool) => tool.name === call.name)?.permission;
    if (
      result.status === 'completed' &&
      call.name !== 'complete_support_case' &&
      call.name !== 'request_human_handoff' &&
      permission !== 'read-only'
    )
      await this.refreshOutcome(sessionId);
    return result;
  }
  async confirm(sessionId: string, id: string, approve: boolean) {
    const result = await this.executor.confirm(sessionId, id, approve);
    if (result.status === 'completed') await this.refreshOutcome(sessionId);
    return result;
  }
  /** Provider-neutral workflow inspection; returns tool names, never invents model answers. */
  async ensureVoiceOutcome(sessionId: string): Promise<string[]> {
    const session = await this.repo.getSession(sessionId);
    if (session.status !== 'active' || session.handoff) return [];
    if (isBusinessScenario(session.scenarioId)) {
      const actions = await this.repo.getActions(sessionId);
      return actions.some((a) => ['appointment', 'lead', 'delivery-change'].includes(String(a.kind))) &&
        !session.outcome
        ? ['complete_support_case']
        : [];
    }
    return [];
  }
  private async tool<T>(id: string, name: string, input: unknown = {}): Promise<T> {
    const execution = await this.executeTool(id, newToolCall(name, input));
    if (execution.status === 'failed') throw new Error(execution.error);
    return (execution.status === 'pending-confirmation' ? execution : execution.result) as T;
  }
  private async say(id: string, text: string) {
    await this.emit(id)('transcript', { role: 'assistant', text, final: true, mode: 'deterministic' });
    return { text };
  }
  async message(id: string, text: string): Promise<{ text: string; outcome?: CallOutcome }> {
    if (typeof text !== 'string' || !text.trim() || text.length > 8000)
      throw new Error('Message must contain 1–8000 characters');
    if (this.busy.has(id)) throw new Error('A diagnostic turn is already running');
    this.busy.add(id);
    try {
      const session = await this.repo.getSession(id);
      if (session.status !== 'active') throw new Error('Session has ended');
      if (session.handoff) {
        await this.emit(id)('transcript', { role: 'user', text, final: true, mode: 'human' });
        return { text: '' };
      }
      await this.emit(id)('transcript', { role: 'user', text, final: true });
      if (
        /(?:talk|speak|transfer|connect).{0,30}(?:human|operator|manager|person)|(?:need|want)\s+(?:a\s+|an\s+|the\s+)?(?:human|operator|manager|person)|(?:human|operator|manager)\s*(?:please|support)|(?:позов|переключ|соедин|поговор|нужен|хочу).{0,35}(?:оператор|менеджер|человек)|^(?:human|operator|manager|оператор|менеджер|человек)[.!?\s]*$/i.test(
          text,
        ) &&
        !/\b(?:don't|do not|without|no need)\b|не (?:нужен|хочу|надо)/i.test(text)
      ) {
        await this.tool(id, 'request_human_handoff', { reason: text.slice(0, 2000) });
        return this.say(
          id,
          isRepairScenario(session.scenarioId)
            ? 'I have passed this conversation to the operator queue with your repair context.'
            : 'I have passed this conversation to the operator queue. Your context is included.',
        );
      }
      if (isRepairScenario(session.scenarioId) && this.textAgent) {
        if (/do not book|don't book|changed my mind|stop booking|never mind|не записывай/i.test(text))
          await this.tool(id, 'update_repair_context', { bookingRequested: false });
        if (/smoke|sparks?|burning smell|дым|искр/i.test(text)) {
          await this.tool(id, 'request_human_handoff', { reason: text.slice(0, 2000) });
          return this.say(
            id,
            'Stop using the appliance and keep away from it if there is smoke or sparking. I have passed your case to an operator. If there is an active fire or immediate danger, contact local emergency services.',
          );
        }
        await this.emit(id)('support.state', {
          state: 'thinking',
          mode: 'generative',
          provider: this.textAgent.provider,
        });
        try {
          const answer = await this.textAgent.respond({
            session: await this.repo.getSession(id),
            events: await this.repo.getEvents(id),
            tools: this.executor.tools,
            execute: (call) => this.executeTool(id, call),
            emit: this.emit(id),
          });
          await this.emit(id)('transcript', {
            role: 'assistant',
            text: answer,
            final: true,
            mode: 'generative',
          });
          return { text: answer };
        } catch {
          await this.emit(id)('error', {
            source: 'text',
            message:
              'The text provider could not finish this turn. Completed actions remain saved; review the booking or request card before retrying.',
          });
          return this.say(
            id,
            'I could not finish that response. Please review the saved booking or request card before trying again, or ask for an operator.',
          );
        }
      }
      if (isRepairScenario(session.scenarioId))
        return await repairMessage(
          session,
          text,
          this.repo,
          (name, input = {}) => this.tool(id, name, input),
          (message) => this.say(id, message),
        );
      if (isBusinessScenario(session.scenarioId))
        return await businessMessage(
          session,
          text,
          this.repo,
          (name, input = {}) => this.tool(id, name, input),
          (message) => this.say(id, message),
        );
      return this.say(id, 'This scenario is no longer available. Start a workshop conversation.');
    } catch (error) {
      const message = String(
        sanitize(error instanceof Error ? error.message : 'Unable to complete diagnosis'),
      );
      await this.emit(id)('error', { message, source: 'deterministic-runtime' });
      return this.say(
        id,
        `I could not complete this step: ${message}. Please review any saved actions before retrying.`,
      );
    } finally {
      this.busy.delete(id);
    }
  }
  private async refreshOutcome(id: string) {
    const session = await this.repo.getSession(id);
    const outcome = session.outcome;
    if (!outcome || session.handoff) return;
    const { customer: _, actions: __, ticketId: ___, ...input } = outcome;
    try {
      await this.tool(id, 'complete_support_case', input);
    } catch (error) {
      // A queued handoff may win between the read above and finalization. The completed
      // action remains valid; the operator owns the next summary from this point onward.
      if (!(await this.repo.getSession(id)).handoff) throw error;
    }
  }
  async endSession(id: string) {
    if (this.busy.has(id)) throw new Error('Wait for the current diagnostic turn to finish');
    let session = await this.repo.getSession(id);
    if (session.status === 'completed') return session;
    if (session.handoff) {
      const customer = await this.repo.getCustomer(session.customerId);
      const actions = await this.repo.getActions(id);
      const tickets = await this.repo.getTickets(id);
      const outcome: CallOutcome = {
        customer: customer.company,
        intent: isBusinessScenario(session.scenarioId)
          ? businessIntent(session.scenarioId)
          : 'technical_support',
        severity: session.outcome?.severity ?? 'low',
        product: session.outcome?.product ?? session.snapshot.account.products[0] ?? 'Support',
        issue: session.outcome?.issue ?? 'Human assistance requested',
        diagnosis: session.handoff.summary,
        resolved: false,
        actions: actions.map((a) => `${String(a.kind)}:${String(a.id)}`),
        ticketId: tickets.at(-1)?.id ?? null,
        nextAction:
          session.handoff.status === 'accepted'
            ? 'The operator accepted this conversation; review the transcript for follow-up.'
            : 'An operator must follow up on the transferred conversation.',
      };
      await this.repo.updateSession(id, { outcome, diagnosis: outcome.diagnosis });
      await this.emit(id)('call.outcome', { outcome });
      session = await this.repo.getSession(id);
    }
    if (!session.outcome && isBusinessScenario(session.scenarioId)) {
      await this.tool(id, 'complete_support_case', {
        intent: businessIntent(session.scenarioId),
        severity: 'low',
        product: session.snapshot.account.products[0] ?? 'Business demo',
        issue: isRepairScenario(session.scenarioId)
          ? 'Appliance repair conversation ended'
          : 'Incomplete business conversation',
        diagnosis: isRepairScenario(session.scenarioId)
          ? 'No confirmed support result was recorded. Appliance diagnosis and repair remain unconfirmed.'
          : 'The conversation ended before a completed business result was recorded.',
        resolved: false,
        nextAction: 'Review the conversation and any saved actions, then follow up with the customer.',
      });
      session = await this.repo.getSession(id);
    }
    if (!session.outcome) {
      const events = await this.repo.getEvents(id);
      const tickets = await this.repo.getTickets(id);
      const ticket = tickets.at(-1);
      const observed = [
        ...new Set(
          events
            .filter(
              (event) =>
                event.type === 'tool.completed' &&
                this.executor.tools.find((tool) => tool.name === event.payload.name)?.permission ===
                  'read-only',
            )
            .map((event) => String(event.payload.name)),
        ),
      ];
      const severity: CallOutcome['severity'] =
        ticket && ['low', 'medium', 'high', 'critical'].includes(ticket.severity)
          ? (ticket.severity as CallOutcome['severity'])
          : observed.length
            ? 'medium'
            : 'low';
      await this.tool(id, 'complete_support_case', {
        intent: 'technical_support',
        severity,
        product: session.snapshot.account.products[0] ?? 'Support',
        issue: ticket?.subject ?? 'Incomplete support investigation',
        diagnosis: `The session ended before a validated diagnosis was recorded. ${observed.length ? `Completed evidence checks: ${observed.join(', ')}.` : 'No completed diagnostic checks were recorded.'} The cause and service recovery remain unconfirmed.`,
        resolved: false,
        nextAction:
          'A human engineer should review the recorded evidence, complete the investigation and verify service recovery.',
      });
    } else if (!session.handoff) await this.refreshOutcome(id);
    session = await this.repo.getSession(id);
    if (session.outcome) {
      const summary = `${session.outcome.issue}. ${session.outcome.diagnosis} Next: ${session.outcome.nextAction}${session.outcome.ticketId ? ` Ticket ${session.outcome.ticketId}.` : ''}`;
      await this.repo.saveMemory(session.customerId, 'summary', summary, id);
      await this.repo.saveMemory(
        session.customerId,
        'case',
        `${session.outcome.issue}; resolved=${session.outcome.resolved}; ${session.outcome.nextAction}`,
        id,
      );
    }
    await this.repo.updateSession(id, { status: 'completed', endedAt: new Date().toISOString() });
    await this.emit(id)('support.state', {
      state: 'completed',
      message: 'Session ended. Relevant support context saved for future sessions.',
    });
    return this.repo.getSession(id);
  }
}
