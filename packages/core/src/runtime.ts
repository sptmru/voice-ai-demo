import { repairMessage } from './repair-runtime.js';
import { isRepairScenario } from './repair-tools.js';
import { businessMessage } from './business-runtime.js';
import { isBusinessScenario, businessIntent } from './business-tools.js';
import type {
  Account,
  CallOutcome,
  EmitEvent,
  Incident,
  PhoneNumber,
  Repository,
  RetrievalService,
  ScenarioId,
  TelecomCall,
  Trunk,
} from './domain.js';
import { ToolExecutor, newToolCall, sanitize, type ToolCall } from './executor.js';

/** No-key mode: an evidence-driven diagnostic policy, deliberately not an LLM. */
export class SupportRuntime {
  readonly executor: ToolExecutor;
  private busy = new Set<string>();
  constructor(
    private repo: Repository,
    private rag: RetrievalService,
    private emitForSession?: (id: string) => EmitEvent,
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
  async startSession(scenario: ScenarioId) {
    const session = await this.repo.createSession(scenario);
    const customer = await this.repo.getCustomer(session.customerId);
    await this.emit(session.id)('customer.identified', { customer });
    const memories = (await this.repo.getMemory(customer.id))
      .slice(0, 5)
      .map((m) => ({ ...m, content: m.content.slice(0, 1200) }));
    await this.emit(session.id)('memory.retrieved', { memories });
    await this.emit(session.id)('support.state', {
      state: 'ready',
      mode: 'deterministic',
      message: 'No-key text mode uses a deterministic diagnostic policy and real local tools.',
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
    const events = await this.repo.getEvents(sessionId);
    const completed = events.filter((event) => event.type === 'tool.completed');
    const diagnosticTools = new Set([
      'get_account',
      'get_recent_calls',
      'get_call_details',
      'check_trunk_status',
      'check_number_configuration',
      'get_service_incidents',
      'create_support_ticket',
      'escalate_to_engineer',
    ]);
    if (!completed.some((event) => diagnosticTools.has(String(event.payload.name)))) return [];
    const searched = completed.filter((event) => event.payload.name === 'search_knowledge_base').at(-1);
    const finalized = completed.filter((event) => event.payload.name === 'complete_support_case').at(-1);
    const callInvestigation = /\b(sip|calls?|calling|trunk|outbound|inbound)\b/i.test(
      events
        .filter((event) => event.type === 'transcript' && event.payload.role === 'user')
        .map((event) => String(event.payload.text))
        .join(' ') +
        ' ' +
        (session.outcome?.issue ?? ''),
    );
    const required = callInvestigation
      ? [
          'get_customer',
          'get_account',
          'get_recent_calls',
          'get_call_details',
          'check_trunk_status',
          'check_number_configuration',
          'get_service_incidents',
        ]
      : [];
    const missing: string[] = required.filter(
      (name) => !completed.some((event) => event.payload.name === name),
    );
    if (!searched) missing.push('search_knowledge_base');
    const latestEvidence = completed
      .filter(
        (event) =>
          required.includes(String(event.payload.name)) || event.payload.name === 'search_knowledge_base',
      )
      .at(-1);
    if (
      missing.length ||
      !session.outcome ||
      !finalized ||
      (latestEvidence && finalized.id < latestEvidence.id)
    )
      missing.push('complete_support_case');
    return missing;
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
      const reset = /reset|rotat|сброс/i.test(text) && /credential|password|trunk|парол/i.test(text);
      if (reset) {
        await this.tool(id, 'reset_trunk_credentials', { reason: text.slice(0, 4000) });
        return this.say(
          id,
          'I have proposed a simulated trunk credential reset. Review and approve the confirmation card to apply it. A new test call is still required to confirm recovery.',
        );
      }
      if (/^(yes|approve|confirm|да|подтверждаю)[.!\s]*$/i.test(text))
        return this.say(
          id,
          'Sensitive actions require the approval card in this session. A text reply cannot approve them.',
        );
      if (/previous|history|last (case|call|session)|истори/i.test(text)) {
        const memories = (await this.repo.getMemory(session.customerId, text)).slice(0, 5);
        await this.emit(id)('memory.retrieved', { memories });
        return this.say(
          id,
          memories.length
            ? `Relevant previous support context: ${memories.map((m) => m.content.slice(0, 500)).join(' ')}`
            : 'There are no matching previous support cases yet.',
        );
      }
      if (/follow.?up|email (me|us)|send (me|us)|письм/i.test(text) && session.outcome) {
        const action = await this.tool<{ id: string }>(id, 'send_followup', {
          message: `${session.outcome.diagnosis} Next step: ${session.outcome.nextAction}`,
        });
        return this.say(
          id,
          `Follow-up ${action.id} was saved locally for the verified customer email. External delivery is mocked.`,
        );
      }
      if (/callback|call (me|us) back|перезвон/i.test(text)) {
        const date = text.match(
          /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})/,
        )?.[0];
        if (!date)
          return this.say(
            id,
            'Please provide the requested callback time with a timezone, for example 2030-09-16T10:00:00+01:00. The callback is a local demo request.',
          );
        const action = await this.tool<{ id: string }>(id, 'schedule_callback', {
          requestedAt: new Date(date).toISOString(),
          reason: session.diagnosis ?? text,
        });
        return this.say(id, `Callback ${action.id} was saved for ${date}. External dispatch is mocked.`);
      }
      if (session.outcome && !/recheck|investigate again|check again|повтор/i.test(text)) {
        if (/escalat|engineer|инженер/i.test(text)) {
          const ticket = await this.ensureTicket(id, session.outcome);
          await this.tool(id, 'escalate_to_engineer', {
            reason: session.outcome.diagnosis,
            priority: 'urgent',
          });
          return this.say(
            id,
            `An engineer escalation was recorded locally for ticket ${ticket.id}. External paging is mocked.`,
          );
        }
        if (/ticket|тикет/i.test(text)) {
          const ticket = await this.ensureTicket(id, session.outcome);
          return this.say(id, `Support ticket ${ticket.id} is saved locally. ${session.outcome.nextAction}`);
        }
        return this.say(
          id,
          `${session.outcome.diagnosis} Next step: ${session.outcome.nextAction} You can request a ticket, follow-up email, callback, engineer escalation or another check.`,
        );
      }
      return await this.diagnose(id, text);
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
  private async ensureTicket(id: string, outcome: Pick<CallOutcome, 'issue' | 'diagnosis' | 'severity'>) {
    const tickets = await this.repo.getTickets(id);
    if (tickets.length) return tickets[tickets.length - 1];
    return this.tool<{ id: string }>(id, 'create_support_ticket', {
      subject: outcome.issue,
      description: outcome.diagnosis,
      severity: outcome.severity,
    });
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
  private async diagnose(id: string, text: string) {
    await this.emit(id)('support.state', {
      state: 'investigating',
      message: 'Checking operational evidence and relevant knowledge.',
    });
    await this.tool(id, 'get_customer');
    const account = await this.tool<Account>(id, 'get_account');
    const calls = await this.tool<TelecomCall[]>(id, 'get_recent_calls', { limit: 10 });
    const failures = calls.filter((call) => call.status === 'failed');
    if (failures[0]) await this.tool(id, 'get_call_details', { callId: failures[0].id });
    const trunk = await this.tool<Trunk>(id, 'check_trunk_status');
    const number = await this.tool<PhoneNumber>(id, 'check_number_configuration');
    const incidents = await this.tool<Incident[]>(id, 'get_service_incidents');
    const inbound = failures.some((call) => call.direction === 'inbound');
    const ukFailures = failures.filter((call) => call.direction === 'outbound' && call.to.startsWith('+44'));
    const query = inbound
      ? 'UK inbound number routing configuration'
      : `SIP ${failures[0]?.sipCode ?? 'failure'} UK outbound calls authentication caller ID international restrictions carrier incident`;
    await this.tool(id, 'search_knowledge_base', { query, limit: 4 });
    let diagnosis: string;
    let nextAction: string;
    let issue: string;
    let intent: CallOutcome['intent'] = 'technical_support';
    let escalation = false;
    if (account.status === 'restricted' || account.balance <= 0) {
      issue = 'Account restriction blocks calling';
      intent = 'account_support';
      diagnosis = `The account is ${account.status} with a balance of ${account.balance.toFixed(2)}. This is consistent with the observed call rejection.`;
      nextAction = 'Ask billing to restore account eligibility, then place a test call.';
    } else if (inbound && (!number.enabled || !number.route || number.route !== trunk.id)) {
      issue = 'Inbound number routing misconfiguration';
      diagnosis = `The incoming number ${number.number} is ${number.enabled ? 'enabled' : 'disabled'} and its route ${number.route ?? 'is missing'} does not provide a valid path to this trunk.`;
      nextAction = 'An engineer should correct the number route and verify an inbound test call.';
      escalation = true;
    } else if (!trunk.credentialsValid || !trunk.registered) {
      issue = 'SIP trunk authentication failure';
      diagnosis = `The trunk is ${trunk.registered ? 'registered' : 'not registered'} and authentication credentials are ${trunk.credentialsValid ? 'valid' : 'invalid'}. Authentication must be restored before carrier troubleshooting.`;
      nextAction =
        'Review trunk authentication; request a simulated credential reset with explicit approval if needed, then test a new call.';
    } else if (!trunk.callerIdVerified) {
      issue = 'Unverified outbound caller ID';
      diagnosis = `Outbound caller ID ${trunk.callerId} is not verified. The observed SIP rejection is consistent with caller-ID policy enforcement.`;
      nextAction = 'Verify or select an authorized caller ID, then repeat an outbound test call.';
    } else if (ukFailures.length && (!account.internationalEnabled || !account.ukEnabled)) {
      issue = 'Destination calling restriction';
      diagnosis = `The account has ${account.internationalEnabled ? 'international calling enabled' : 'international calling disabled'} and ${account.ukEnabled ? 'UK calling enabled' : 'UK calling disabled'}. These restrictions explain rejection of UK destinations.`;
      nextAction =
        'An authorized account administrator should enable the required destination permission and test a new call.';
    } else {
      const incident = incidents.find(
        (item) =>
          /uk|united kingdom/i.test(`${item.region} ${item.title}`) &&
          !/^resolved|closed$/i.test(item.status),
      );
      if (ukFailures.length && incident) {
        issue = 'UK outbound carrier degradation';
        diagnosis = `${ukFailures.length} recent UK outbound calls failed (SIP ${[...new Set(ukFailures.map((c) => c.sipCode))].join(', ')}). Account permissions, trunk authentication and caller ID are valid. Active incident ${incident.id}: ${incident.title} (${incident.status}) is the likely cause.`;
        nextAction = `Monitor incident ${incident.id}; retry a controlled test call after the carrier reports recovery.`;
      } else {
        issue = 'Unexplained call failures';
        diagnosis =
          'Current account, trunk and number checks do not establish a known cause, and no matching active incident explains these failures. A human engineer needs to inspect signaling traces.';
        nextAction =
          'An engineer should review affected call IDs and SIP traces; avoid changing credentials without evidence.';
        escalation = true;
      }
    }
    const severity: CallOutcome['severity'] = failures.length >= 3 ? 'high' : 'medium';
    if (/ticket|тикет|escalat|engineer/i.test(text) || escalation)
      await this.ensureTicket(id, { issue, diagnosis, severity });
    if (escalation || /escalat/i.test(text))
      await this.tool(id, 'escalate_to_engineer', {
        reason: diagnosis,
        priority: severity === 'high' ? 'urgent' : 'normal',
      });
    const outcome = await this.tool<CallOutcome>(id, 'complete_support_case', {
      intent,
      severity,
      product: 'SIP Trunking',
      issue,
      diagnosis,
      resolved: false,
      nextAction,
    });
    await this.emit(id)('support.state', { state: 'diagnosed', message: issue });
    const reply = `${diagnosis} ${outcome.ticketId ? `Support ticket ${outcome.ticketId} was saved locally. ` : ''}${escalation ? 'An engineer escalation was recorded locally; external paging is mocked. ' : ''}${nextAction}`;
    await this.say(id, reply);
    return { text: reply, outcome };
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
