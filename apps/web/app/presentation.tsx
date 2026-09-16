'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import {
  ArrowRight,
  AudioLines,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Headphones,
  LoaderCircle,
  MessageSquare,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  RefreshCw,
  Send,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { KnowledgeEvidence, type EvidenceResult } from './knowledge-evidence';
import type { AgentEvent, Customer, SupportSession } from '../../../packages/core/src/domain';

export type DemoScenario = {
  id: string;
  label: string;
  prompt: string;
  description?: string;
  result?: string;
  category?: string;
  quickPrompts?: string[];
};
export type Handoff = {
  status: 'waiting' | 'accepted';
  reason: string;
  summary: string;
  requestedAt: string;
  acceptedAt?: string;
  messages?: unknown[];
};
type SessionDetail = {
  session: SupportSession;
  customer: Customer;
  actions?: Record<string, unknown>[];
  handoff?: Handoff | null;
};
const value = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const business: Record<
  string,
  { title: string; description: string; result: string; Icon: typeof CalendarDays }
> = {
  'repair-advice': {
    title: 'Appliance troubleshooting',
    description: 'Describe the problem and find out what to do next.',
    result: 'A clear answer with sources',
    Icon: Wrench,
  },
  'repair-booking': {
    title: 'Book a repair',
    description: 'Check the repair terms and choose an appointment time.',
    result: 'An appointment with a confirmed time',
    Icon: CalendarDays,
  },
  'repair-status': {
    title: 'Check repair status',
    description: 'Find out how the repair is progressing.',
    result: 'Repair status and the next step',
    Icon: CheckCircle2,
  },
};
const actionLabels: Record<string, string> = {
  appointment: 'Appointment booked',
  'appointment-rescheduled': 'Appointment rescheduled',
  'appointment-cancelled': 'Appointment cancelled',
  'repair-quote-approved': 'Repair quote approved',
  reschedule_appointment: 'Moved the appointment',
  cancel_appointment: 'Cancelled the appointment',
  approve_repair_quote: 'Recorded customer approval',
  update_repair_context: 'Updated appliance details',
  get_repair_catalog: 'Checked services and prices',
  get_repair_status: 'Checked repair status',
  lead: 'Qualified lead saved',
  'delivery-change': 'Delivery change requested',
  list_services: 'Checked available services',
  list_available_slots: 'Checked available appointment times',
  save_lead: 'Saved a qualified lead',
  request_delivery_change: 'Recorded the delivery change request',
  check_availability: 'Checked available appointment times',
  get_availability: 'Checked available appointment times',
  book_appointment: 'Booked an appointment',
  create_appointment: 'Booked an appointment',
  create_lead: 'Saved a qualified lead',
  qualify_lead: 'Qualified the lead',
  lookup_order: 'Found the order',
  get_order: 'Checked the order',
  update_delivery: 'Recorded a delivery request',
  request_order_change: 'Recorded an order change request',
  create_support_ticket: 'Opened a support ticket',
  search_knowledge: 'Found relevant information',
  search_knowledge_base: 'Found relevant information',
  request_human_handoff: 'Requested a team member',
  complete_support_case: 'Saved the conversation result',
  request_handoff: 'Requested a team member',
  schedule_callback: 'Recorded a callback request',
  send_followup: 'Prepared a follow-up',
  get_customer: 'Loaded the customer details',
};
function actionLabel(name: unknown) {
  const text = value(name);
  return actionLabels[text] || text.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
}
function safeCalendarUrl(raw: unknown) {
  try {
    const url = new URL(value(raw));
    return url.protocol === 'https:' && ['calendar.google.com', 'www.google.com'].includes(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function ActionResult({ action, timeZone = 'UTC' }: { action: Record<string, unknown>; timeZone?: string }) {
  const input = object(action.input);
  const output = object(action.result || action.output);
  const data = { ...input, ...output };
  const confirmedExternal = data.provider === 'google' && data.status === 'confirmed';
  const link = safeCalendarUrl(data.htmlLink || data.calendarUrl || data.eventUrl);
  const fields = [
    'name',
    'email',
    'company',
    'service',
    'serviceName',
    'start',
    'startTime',
    'timeZone',
    'budget',
    'timeline',
    'needs',
    'need',
    'end',
    'address',
    'status',
    'orderId',
    'requestedChange',
    'reason',
    'summary',
    'jobId',
    'estimateAMD',
  ];
  return (
    <article className="demo-result-action">
      <div className="demo-result-title">
        <CheckCircle2 size={18} />
        <strong>{actionLabel(action.kind || action.type)}</strong>
        <span className={`demo-badge ${confirmedExternal ? 'connected' : ''}`}>
          {confirmedExternal ? 'Google Calendar' : 'Local demo record'}
        </span>
      </div>
      <dl>
        {fields
          .filter((key) => value(data[key]))
          .map((key) => (
            <div key={key}>
              <dt>{key.replace(/([A-Z])/g, ' $1')}</dt>
              <dd>
                {['start', 'end', 'startTime'].includes(key) && Number.isFinite(Date.parse(value(data[key])))
                  ? new Date(value(data[key])).toLocaleString('en-GB', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                      timeZone,
                    }) + ` (${timeZone})`
                  : value(data[key])}
              </dd>
            </div>
          ))}
      </dl>
      {link && (
        <a className="calendar-link" href={link} target="_blank" rel="noreferrer">
          Open in Google Calendar <ExternalLink size={14} />
        </a>
      )}
    </article>
  );
}
function Transcript({
  events,
  partial,
  handoff,
}: {
  events: AgentEvent[];
  partial?: string;
  handoff?: Handoff | null;
}) {
  const end = useRef<HTMLDivElement>(null);
  const turns = events.filter((e) => e.type === 'transcript');
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [turns.length, partial]);
  return (
    <div className="demo-transcript" aria-live="polite" aria-relevant="additions text">
      {!turns.length && (
        <div className="demo-conversation-empty">
          <AudioLines size={30} />
          <h3>{handoff ? 'Continue with your team.' : 'Your agent is ready.'}</h3>
          <p>
            {handoff
              ? 'Write a message below. The AI is paused while the team helps.'
              : 'Speak naturally, ask a follow-up, or use the suggested message below.'}
          </p>
        </div>
      )}
      {turns.map((event) => (
        <div
          key={event.id}
          className={`transcript-turn ${event.payload.role === 'user' ? 'user-turn' : 'agent-turn'}`}
        >
          <div className="turn-author">
            <span>
              {event.payload.role === 'user'
                ? 'YOU'
                : event.payload.role === 'operator'
                  ? 'TEAM MEMBER'
                  : 'RELAY AGENT'}
            </span>
            <time>
              {new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </time>
          </div>
          <p>{value(event.payload.text)}</p>
        </div>
      ))}
      {partial && <p className="partial-transcript">{partial}</p>}
      <div ref={end} />
    </div>
  );
}
export function Presentation(props: {
  intake?: ReactNode;
  records?: ReactNode;
  confirmations?: ReactNode;
  scenarios: DemoScenario[];
  scenario: string;
  onScenario: (id: string) => void;
  detail?: SessionDetail;
  events: AgentEvent[];
  busy: boolean;
  ready: boolean;
  input: string;
  onInput: (v: string) => void;
  onStart: (textOnly?: boolean) => void;
  onSend: (text: string) => void;
  onEnd: () => void;
  voiceState: string;
  voiceAvailable: boolean;
  muted: boolean;
  onMute: () => void;
  onToggleVoice: () => void;
  partialTranscript: string;
  seconds: number;
  onHandoff: () => void;
  onOpenOperator: () => void;
  technicalDetails: boolean;
  onTechnicalDetails: () => void;
}) {
  const { detail, busy, events } = props;
  const active = !!detail && detail.session.status !== 'completed';
  const handoff = detail?.handoff;
  const connected = props.voiceState === 'connected';
  const connecting = ['requesting-microphone', 'connecting'].includes(props.voiceState);
  const selected = props.scenarios.find((s) => s.id === props.scenario);
  const activeScenario = props.scenarios.find((s) => s.id === detail?.session.scenarioId);
  const promptScenario = active ? activeScenario : selected;
  const firstUserTurn = !events.some((event) => event.type === 'transcript' && event.payload.role === 'user');
  const suggestedPrompts = promptScenario?.quickPrompts?.length
    ? [
        ...new Set([
          ...(firstUserTurn && props.scenario.startsWith('repair-') ? [promptScenario.prompt] : []),
          ...promptScenario.quickPrompts,
        ]),
      ]
    : [promptScenario?.prompt || 'How can you help me?'];
  const outcome = detail?.session.outcome;
  const latestRetrieval = [...events].reverse().find((event) => event.type === 'retrieval.completed');
  const evidence =
    latestRetrieval && Array.isArray(latestRetrieval.payload.chunks)
      ? (latestRetrieval.payload as unknown as EvidenceResult)
      : undefined;
  const milestones = events.filter((e) =>
    [
      'tool.completed',
      'tool.failed',
      'retrieval.completed',
      'handoff.requested',
      'handoff.accepted',
    ].includes(e.type),
  );
  return (
    <div className="demo-view">
      <div className="demo-section-label">
        <span>01 / HOW CAN WE HELP WITH YOUR APPLIANCE?</span>
        <small>Fictional workshop · demonstration data</small>
      </div>
      <div className="demo-scenarios" role="group" aria-label="Repair scenarios">
        {props.scenarios
          .filter((s) => business[s.id])
          .map((s) => {
            const info = business[s.id]!;
            const Icon = info.Icon;
            return (
              <button
                key={s.id}
                className={`demo-scenario ${props.scenario === s.id ? 'chosen' : ''}`}
                aria-pressed={props.scenario === s.id}
                onClick={() => props.onScenario(s.id)}
                disabled={busy}
              >
                <span className="demo-scenario-icon">
                  <Icon size={22} />
                </span>
                <strong>{info.title}</strong>
                <p>{s.description || info.description}</p>
                <span className="demo-scenario-result">
                  <ArrowRight size={13} />
                  {s.result || info.result}
                </span>
              </button>
            );
          })}
      </div>
      <details className="demo-other-scenarios">
        <summary>
          Other scenarios <ChevronDown size={14} />
        </summary>
        <label htmlFor="other-scenario">All demo scenarios</label>
        <select
          id="other-scenario"
          value={props.scenario}
          onChange={(event) => props.onScenario(event.target.value)}
          disabled={busy}
        >
          <optgroup label="Appliance repair">
            {props.scenarios
              .filter((s) => business[s.id])
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
          </optgroup>
          <optgroup label="Other tasks and technical support">
            {props.scenarios
              .filter((s) => !business[s.id])
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
          </optgroup>
        </select>
      </details>
      <section className="demo-launch">
        <div>
          <span className="eyebrow">02 / TRY THE CONVERSATION</span>
          <h2>
            {active
              ? activeScenario?.label || 'Conversation in progress'
              : selected?.label || 'Choose your scenario'}
          </h2>
          <p>
            {active
              ? 'Your conversation, sources, and results stay together below.'
              : props.voiceAvailable
                ? 'Talk to the agent in your browser or start with a message.'
                : 'Start with a message to try the complete workflow.'}
          </p>
          {active && detail.session.scenarioId !== props.scenario && (
            <p className="demo-next-scenario">Selected for the next session: {selected?.label}</p>
          )}
        </div>
        <div className="demo-launch-actions">
          <button
            className="button primary demo-start"
            onClick={() => props.onStart()}
            disabled={!props.ready || busy}
          >
            {busy ? <LoaderCircle size={20} className="spin" /> : <Phone size={20} />}
            {detail ? 'Reset session' : 'Start session'}
          </button>
          <button
            className="demo-text-start"
            onClick={() => props.onStart(true)}
            disabled={!props.ready || busy}
          >
            <MessageSquare size={14} />
            {active ? 'New text session' : 'Start in text'}
          </button>
        </div>
      </section>
      <div className="demo-live-grid">
        <section className="panel demo-conversation">
          <div className="panel-heading">
            <h2>
              <AudioLines size={17} />
              Conversation
            </h2>
            <span className={`status-pill ${active ? 'green' : ''}`}>
              {handoff
                ? handoff.status === 'accepted'
                  ? 'With a team member'
                  : 'Waiting for a team member'
                : active
                  ? 'In session'
                  : detail
                    ? 'Completed'
                    : 'Ready'}
            </span>
          </div>
          {active && (
            <div className="demo-session-controls">
              <span className="demo-call-status">
                <span className={`dot ${connected ? 'pulse' : ''}`} />
                {handoff
                  ? 'AI paused · continue in text'
                  : connecting
                    ? 'Connecting voice…'
                    : connected
                      ? props.muted
                        ? 'Microphone muted'
                        : 'Listening'
                      : 'Text conversation'}
                <time>
                  {Math.floor(props.seconds / 60)}:{String(props.seconds % 60).padStart(2, '0')}
                </time>
              </span>
              <div>
                {connected && (
                  <button
                    className="round-button"
                    aria-label={props.muted ? 'Unmute microphone' : 'Mute microphone'}
                    onClick={props.onMute}
                  >
                    {props.muted ? <MicOff size={16} /> : <Mic size={16} />}
                  </button>
                )}
                {props.voiceAvailable && !handoff && (
                  <button
                    className="button outline"
                    onClick={props.onToggleVoice}
                    disabled={busy || connecting}
                  >
                    {connected
                      ? 'Disconnect voice'
                      : ['error', 'closed'].includes(props.voiceState)
                        ? 'Reconnect voice'
                        : 'Connect voice'}
                  </button>
                )}
                <button
                  className="round-button hangup"
                  onClick={props.onEnd}
                  disabled={busy}
                  aria-label="End session"
                >
                  <PhoneOff size={16} />
                </button>
              </div>
            </div>
          )}
          {handoff && (
            <div className="demo-handoff-banner">
              <Headphones size={19} />
              <div>
                <strong>
                  {handoff.status === 'accepted'
                    ? 'A team member has joined.'
                    : 'Your context is ready for a team member.'}
                </strong>
                <p>{handoff.reason}</p>
              </div>
              <button className="button outline" onClick={props.onOpenOperator}>
                Open operator desk
              </button>
            </div>
          )}
          <Transcript events={events} partial={props.partialTranscript} handoff={handoff} />
          {props.confirmations}
          {props.intake}
          {active &&
          !handoff &&
          (promptScenario?.quickPrompts?.length ||
            !events.some((e) => e.type === 'transcript' && e.payload.role === 'user')) ? (
            <div className="demo-prompts">
              {suggestedPrompts.map((prompt) => (
                <button
                  key={prompt}
                  className="starter-prompt"
                  disabled={busy || connecting}
                  onClick={() => props.onSend(prompt)}
                >
                  <Sparkles size={13} />
                  <span>Try: {prompt}</span>
                  <ArrowRight size={13} />
                </button>
              ))}
            </div>
          ) : null}
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              props.onSend(props.input);
            }}
          >
            <label className="sr-only" htmlFor="demo-message">
              Message the support agent
            </label>
            <textarea
              id="demo-message"
              rows={2}
              value={props.input}
              onChange={(event) => props.onInput(event.target.value)}
              placeholder={
                active
                  ? handoff
                    ? 'Message the team…'
                    : 'Ask a question or describe what you need…'
                  : 'Start a session to begin…'
              }
              disabled={!active || busy || connecting}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  props.onSend(props.input);
                }
              }}
            />
            <button aria-label="Send message" disabled={!active || busy || connecting || !props.input.trim()}>
              <Send size={17} />
            </button>
          </form>
          <div className="demo-conversation-footer">
            <span>{busy ? 'Working on your request…' : 'Enter to send · Shift + Enter for a new line'}</span>
            {active && !handoff && (
              <button disabled={busy || connecting} onClick={props.onHandoff}>
                <Headphones size={14} />
                Talk to a person
              </button>
            )}
          </div>
        </section>
        <aside className="demo-progress">
          {props.records}
          {evidence && <KnowledgeEvidence result={evidence} />}
          <section className="panel">
            <div className="panel-heading">
              <h2>
                <CheckCircle2 size={17} />
                Actions as they happen
              </h2>
            </div>
            <div className="demo-milestones" aria-live="polite">
              {!milestones.length && (
                <div className="demo-placeholder">
                  <Wrench size={22} />
                  <p>The agent's completed steps will appear here.</p>
                </div>
              )}
              {milestones.map((event) => (
                <div
                  className={`demo-milestone ${event.type === 'tool.failed' ? 'failed' : ''}`}
                  key={event.id}
                >
                  {event.type === 'tool.failed' ? <Wrench size={16} /> : <CheckCircle2 size={16} />}
                  <div>
                    <strong>
                      {event.type === 'handoff.requested'
                        ? 'Prepared the handoff'
                        : event.type === 'handoff.accepted'
                          ? 'Team member joined'
                          : event.type === 'retrieval.completed'
                            ? 'Checked the knowledge base'
                            : actionLabel(event.payload.name || event.payload.toolName || event.payload.tool)}
                    </strong>
                    {event.type === 'tool.failed' && (
                      <p>The action did not complete. Check the conversation for next steps.</p>
                    )}
                    <time>
                      {new Date(event.timestamp).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </div>
                </div>
              ))}
            </div>
          </section>
          <section className="panel demo-result" aria-label="Conversation result">
            <div className="panel-heading">
              <h2>
                <Sparkles size={17} />
                Your result
              </h2>
            </div>
            <div className="demo-result-body">
              {outcome && (
                <>
                  <h3>{outcome.issue}</h3>
                  <p>{outcome.diagnosis}</p>
                  <div className="demo-next-step">
                    <small>NEXT STEP</small>
                    <p>{outcome.nextAction}</p>
                  </div>
                </>
              )}
              {detail?.actions?.map((action, i) => (
                <ActionResult
                  key={value(action.id) || i}
                  action={action}
                  timeZone={detail?.session.snapshot.business?.calendarTimeZone}
                />
              ))}
              {!outcome && !detail?.actions?.length && (
                <div className="demo-placeholder">
                  <CalendarDays size={25} />
                  <p>
                    {business[detail?.session.scenarioId || props.scenario]?.result ||
                      'The result of your conversation'}{' '}
                    will appear here.
                  </p>
                  <small>External bookings are shown only after Google Calendar confirms them.</small>
                </div>
              )}
            </div>
          </section>
        </aside>
      </div>
      <button
        className="demo-technical-toggle"
        aria-expanded={props.technicalDetails}
        onClick={props.onTechnicalDetails}
      >
        <Wrench size={15} />
        {props.technicalDetails ? 'Hide technical details' : 'Explore technical details'}
        <ChevronDown size={15} />
      </button>
    </div>
  );
}
export function OperatorPanel(props: {
  repairRecords?: ReactNode;
  queue: SessionDetail[];
  detail?: SessionDetail;
  events: AgentEvent[];
  busy: boolean;
  onRefresh: () => void;
  onOpen: (id: string) => void;
  onAccept: () => void;
  input: string;
  onInput: (v: string) => void;
  onSend: () => void;
  onEnd: () => void;
}) {
  const handoff = props.detail?.handoff;
  const active = props.detail?.session.status === 'active';
  return (
    <section className="operator-view">
      <div className="operator-intro">
        <div>
          <span className="eyebrow">OPERATOR DEMO</span>
          <h2>A warm handoff, with context.</h2>
          <p>
            Only conversations from this browser appear here. Accept a request to reply as the team member in
            text.
          </p>
        </div>
        <button className="button outline" onClick={props.onRefresh} disabled={props.busy}>
          <RefreshCw size={15} />
          Refresh queue
        </button>
      </div>
      <div className="operator-grid">
        <aside className="panel operator-queue">
          <div className="panel-heading">
            <h2>Conversation queue</h2>
            <span className="count">{props.queue.length}</span>
          </div>
          {!props.queue.length && (
            <p className="demo-placeholder">No handoffs yet. Ask for a person in the demo to try it.</p>
          )}
          {props.queue.map((item) => (
            <button
              key={item.session.id}
              className={`operator-queue-item ${props.detail?.session.id === item.session.id ? 'selected' : ''}`}
              onClick={() => props.onOpen(item.session.id)}
              disabled={props.busy}
            >
              <strong>{item.customer.name}</strong>
              <span>{item.handoff?.reason}</span>
              <small>
                {item.handoff?.status === 'accepted' ? 'Accepted' : 'Waiting'} · {item.session.id.slice(0, 8)}
              </small>
            </button>
          ))}
        </aside>
        <section className="panel operator-conversation">
          {handoff ? (
            <>
              <div className="panel-heading">
                <h2>
                  <Headphones size={17} />
                  {props.detail?.customer.name}
                </h2>
                <span className="status-pill green">{active ? handoff.status : 'Completed'}</span>
              </div>
              <div className="operator-brief">
                <small>WHY THEY NEED YOU</small>
                <p>{handoff.reason}</p>
                <small>CONVERSATION SUMMARY</small>
                <p>{handoff.summary}</p>
                <div className="operator-customer">
                  <span>{props.detail?.customer.company}</span>
                  <span>{props.detail?.customer.email}</span>
                  <span>{props.detail?.customer.phone}</span>
                </div>
                {props.detail?.actions?.map((action, i) => (
                  <ActionResult
                    key={value(action.id) || i}
                    action={action}
                    timeZone={props.detail?.session.snapshot.business?.calendarTimeZone}
                  />
                ))}
                {active && handoff.status === 'waiting' && (
                  <button className="button primary" disabled={props.busy} onClick={props.onAccept}>
                    <Headphones size={16} />
                    Accept conversation
                  </button>
                )}
                {active && handoff.status === 'accepted' && (
                  <button className="button outline" disabled={props.busy} onClick={props.onEnd}>
                    End conversation
                  </button>
                )}
              </div>
              {props.repairRecords}
              <Transcript events={props.events} handoff={handoff} />
              <form
                className="composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  props.onSend();
                }}
              >
                <label className="sr-only" htmlFor="operator-message">
                  Message as team member
                </label>
                <textarea
                  id="operator-message"
                  rows={2}
                  value={props.input}
                  onChange={(event) => props.onInput(event.target.value)}
                  disabled={!active || handoff.status !== 'accepted' || props.busy}
                  placeholder={
                    handoff.status === 'accepted'
                      ? 'Reply as the team member…'
                      : 'Accept the conversation to reply…'
                  }
                />
                <button
                  aria-label="Send operator message"
                  disabled={!active || handoff.status !== 'accepted' || props.busy || !props.input.trim()}
                >
                  <Send size={17} />
                </button>
              </form>
              <div className="composer-note">Your reply is visible in the customer conversation.</div>
            </>
          ) : (
            <div className="demo-placeholder">
              <Headphones size={30} />
              <h3>Select a conversation</h3>
              <p>Review the summary and collected details before you join.</p>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
