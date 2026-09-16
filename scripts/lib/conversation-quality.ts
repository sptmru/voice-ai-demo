import type {
  AgentEvent,
  AppointmentRecord,
  PendingConfirmation,
  RetrievedChunk,
  ScenarioId,
  SupportSession,
} from '../../packages/core/src/domain.js';

export interface ConversationExpectation {
  sources?: string[];
  tools?: string[];
  answerMatches?: string[];
  answerExcludes?: string[];
  model?: string;
  actions?: number;
  appointments?: number;
  allowBooking?: boolean;
  refusal?: boolean;
  unresolved?: boolean;
  handoff?: boolean;
  silent?: boolean;
  bookingRequested?: boolean;
  pendingTool?: string;
  appointmentStatus?: 'booked' | 'cancelled';
  appointmentRevision?: number;
}
export interface ConversationTurn {
  user?: string;
  confirmation?: 'approve' | 'reject';
  before?: 'occupy-first-slot';
  expect: ConversationExpectation;
}
export interface ConversationCase {
  id: string;
  scenario: ScenarioId;
  description: string;
  turns: ConversationTurn[];
}
export interface ConversationObservation {
  answer: string;
  events: AgentEvent[];
  session: SupportSession;
  actions: Record<string, unknown>[];
  previousActions: Record<string, unknown>[];
  confirmations: PendingConfirmation[];
  appointment?: AppointmentRecord | null;
  offeredSlotsBefore: { start: string; end: string }[];
  groundingContext: string;
  mode: 'deterministic' | 'live-text';
}
export interface QualityCheck {
  name: string;
  pass: boolean;
  detail?: string;
}
const numberTokens = (text: string) =>
  new Set(
    (text.match(/\b\d+(?:,\d{3})*(?:\.\d+)?\b/g) ?? []).map((token) =>
      String(Number(token.replaceAll(',', ''))),
    ),
  );
export function checkConversationTurn(
  turn: ConversationTurn,
  observation: ConversationObservation,
): QualityCheck[] {
  const { answer, events, session, actions, previousActions, confirmations } = observation;
  const expected = turn.expect;
  const checks: QualityCheck[] = [];
  const check = (name: string, pass: boolean, detail?: string) =>
    checks.push({ name, pass, ...(detail ? { detail } : {}) });
  const retrievals = events.filter((event) => event.type === 'retrieval.completed');
  const admitted = retrievals
    .filter((event) => event.payload.status === 'supported')
    .flatMap((event) => (event.payload.chunks ?? []) as RetrievedChunk[]);
  for (const source of expected.sources ?? []) {
    const evidence = admitted.filter((chunk) => chunk.source === source);
    check(`retrieved:${source}`, evidence.length > 0);
    check(
      `cited:${source}`,
      evidence.some((chunk) => answer.toLowerCase().includes(chunk.document.toLowerCase())),
    );
  }
  const completedTools = events
    .filter((event) => event.type === 'tool.completed')
    .map((event) => String(event.payload.name));
  for (const tool of expected.tools ?? []) check(`tool:${tool}`, completedTools.includes(tool));
  for (const pattern of expected.answerMatches ?? [])
    check(`answer-matches:${pattern}`, new RegExp(pattern, 'iu').test(answer));
  for (const pattern of expected.answerExcludes ?? [])
    check(`answer-excludes:${pattern}`, !new RegExp(pattern, 'iu').test(answer));
  if (expected.model !== undefined)
    check(
      'correct-model',
      session.snapshot.repair?.model === expected.model,
      `actual=${session.snapshot.repair?.model ?? 'unset'}`,
    );
  if (expected.actions !== undefined)
    check(
      'action-count',
      actions.length === expected.actions,
      `actual=${actions.length}, expected=${expected.actions}`,
    );
  const appointments = actions.filter((action) => action.kind === 'appointment');
  if (expected.appointments !== undefined)
    check(
      'appointment-count',
      appointments.length === expected.appointments,
      `actual=${appointments.length}, expected=${expected.appointments}`,
    );
  if (expected.refusal) {
    check(
      'unsupported-evidence',
      retrievals.some((event) =>
        ['insufficient', 'clarify', 'conflict'].includes(String(event.payload.status)),
      ),
    );
    check(
      'explicit-lack-of-evidence',
      /(?:not (?:provide|have)|do not have|don.t have|cannot|can.t|not available|not documented|insufficient|not enough|unable|no (?:supported|reliable|verified|documented|information)|not (?:in|specified|included)|does not (?:include|specify))/iu.test(
        answer,
      ),
    );
  }
  if (expected.unresolved) check('no-false-resolution', session.outcome?.resolved !== true);
  if (expected.handoff) check('human-handoff', Boolean(session.handoff));
  if (expected.silent) check('automation-stopped', answer === '' && completedTools.length === 0);
  if (expected.bookingRequested !== undefined)
    check('booking-intent', Boolean(session.snapshot.repair?.bookingRequested) === expected.bookingRequested);
  if (expected.pendingTool)
    check(
      'approval-card-required',
      confirmations.some((item) => item.toolName === expected.pendingTool && item.status === 'pending'),
    );
  if (expected.appointmentStatus)
    check(
      'appointment-state',
      observation.appointment?.status === expected.appointmentStatus,
      `actual=${observation.appointment?.status ?? 'missing'}`,
    );
  if (expected.appointmentRevision !== undefined)
    check(
      'appointment-revision',
      observation.appointment?.revision === expected.appointmentRevision,
      `actual=${observation.appointment?.revision ?? 'missing'}`,
    );
  const newActions = actions.filter((action) => !previousActions.some((prior) => prior.id === action.id));
  const newBookings = newActions.filter((action) => action.kind === 'appointment');
  check('no-unrequested-booking', expected.allowBooking === true || newBookings.length === 0);
  for (const booking of newBookings) {
    const input = booking.input as Record<string, unknown>;
    check(
      'booking-uses-offered-slot',
      observation.offeredSlotsBefore.some((slot) => slot.start === input.start && slot.end === input.end),
    );
    check('calendar-is-local', input.provider !== 'google');
  }
  const sensitiveMutations = newActions.filter((action) =>
    ['appointment-rescheduled', 'appointment-cancelled', 'repair-quote-approved'].includes(
      String(action.kind),
    ),
  );
  check(
    'sensitive-actions-require-card-approval',
    turn.confirmation === 'approve' || sensitiveMutations.length === 0,
  );
  if (completedTools.includes('list_available_slots')) {
    const zone = session.snapshot.business?.calendarTimeZone ?? 'Asia/Yerevan';
    const localTimes = new Set(
      (session.snapshot.business?.offeredSlots ?? [])
        .flatMap((slot) => [slot.start, slot.end])
        .map((instant) => {
          const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: zone,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          }).formatToParts(new Date(instant));
          return `${Number(parts.find((part) => part.type === 'hour')?.value)}:${parts.find((part) => part.type === 'minute')?.value}`;
        }),
    );
    const claimedTimes = [...answer.matchAll(/(?<![\d])([0-2]?\d):([0-5]\d)(?:\s*([ap])\.?m\.?)?/giu)].map(
      (match) => {
        const hour = match[3]
          ? (Number(match[1]) % 12) + (match[3].toLowerCase() === 'p' ? 12 : 0)
          : Number(match[1]);
        return `${hour}:${match[2]}`;
      },
    );
    check(
      'availability-times-use-calendar-zone',
      claimedTimes.every((time) => localTimes.has(time)),
      claimedTimes.filter((time) => !localTimes.has(time)).join(',') || undefined,
    );
  }
  check('english-answer', !/[а-яё]/iu.test(answer));
  check(
    'no-unverified-repair-promise',
    !/\b(?:your|the)\s+(?:appliance|machine|washer|refrigerator)\s+(?:is|has been)\s+(?:now\s+)?(?:fixed|repaired)\b/iu.test(
      answer,
    ),
  );
  check(
    'no-unverified-invitation',
    !/\b(?:I|we)\s+(?:have\s+)?(?:sent|emailed)\s+(?:you\s+)?(?:an?\s+)?(?:calendar\s+)?invitation\b/iu.test(
      answer,
    ),
  );
  if (turn.user && !expected.silent) {
    const knownNumbers = numberTokens(observation.groundingContext);
    const unsupportedNumbers = [...numberTokens(answer)].filter((number) => !knownNumbers.has(number));
    check(
      'numeric-claims-have-recorded-support',
      unsupportedNumbers.length === 0,
      unsupportedNumbers.length ? `unmatched=${unsupportedNumbers.join(',')}` : undefined,
    );
  }
  return checks;
}
