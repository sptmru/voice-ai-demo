import { describe, expect, it } from 'vitest';
import { checkConversationTurn, type ConversationObservation } from '../scripts/lib/conversation-quality.js';
import type { AgentEvent } from '../packages/core/src/domain.js';
import { scenarioSnapshot } from '../packages/db/src/fixtures.js';
const event = (type: AgentEvent['type'], payload: Record<string, unknown>): AgentEvent => ({
  id: 1,
  sessionId: 'evaluation',
  correlationId: 'test',
  timestamp: '2026-09-16T10:00:00.000Z',
  type,
  payload,
});
const observation = (patch: Partial<ConversationObservation> = {}): ConversationObservation => ({
  answer: 'The current documents do not provide enough evidence to answer.',
  events: [],
  session: {
    id: 'evaluation',
    customerId: 'demo',
    scenarioId: 'repair-advice',
    status: 'active',
    createdAt: '2026-09-16T10:00:00.000Z',
    endedAt: null,
    diagnosis: null,
    outcome: null,
    snapshot: scenarioSnapshot('repair-advice'),
  },
  actions: [],
  previousActions: [],
  confirmations: [],
  offeredSlotsBefore: [],
  groundingContext: '',
  mode: 'deterministic',
  ...patch,
});
const failed = (checks: ReturnType<typeof checkConversationTurn>) =>
  checks.filter((check) => !check.pass).map((check) => check.name);
describe('conversation quality assertions', () => {
  it('does not treat a citation invented in the answer as retrieved evidence', () => {
    const checks = checkConversationTurn(
      { user: 'Warranty?', expect: { sources: ['repair/warranty.md'] } },
      observation({
        answer: 'According to Repair warranty, the term is 90 days.',
        groundingContext: '90 days',
      }),
    );
    expect(failed(checks)).toContain('retrieved:repair/warranty.md');
    expect(failed(checks)).toContain('cited:repair/warranty.md');
  });
  it('checks numeric claims against recorded evidence and rejects an invented duration', () => {
    const supported = event('retrieval.completed', {
      status: 'supported',
      chunks: [
        {
          source: 'repair/warranty.md',
          document: 'Repair warranty',
          content: 'The repair warranty is 90 days.',
        },
      ],
    });
    const checks = checkConversationTurn(
      { user: 'Warranty?', expect: { sources: ['repair/warranty.md'] } },
      observation({
        events: [supported],
        answer: 'Repair warranty: 900 days.',
        groundingContext: 'The repair warranty is 90 days.',
      }),
    );
    expect(failed(checks)).toEqual(['numeric-claims-have-recorded-support']);
    expect(
      failed(
        checkConversationTurn(
          { user: 'Warranty?', expect: { sources: ['repair/warranty.md'] } },
          observation({
            events: [supported],
            answer: 'Repair warranty: 90 days.',
            groundingContext: 'The repair warranty is 90 days.',
          }),
        ),
      ),
    ).toEqual([]);
  });
  it('requires supported status, not just nearby retrieved text, for an evidence assertion', () => {
    const checks = checkConversationTurn(
      { user: 'Warranty?', expect: { sources: ['repair/warranty.md'] } },
      observation({
        answer: 'Repair warranty.',
        events: [
          event('retrieval.completed', {
            status: 'conflict',
            chunks: [{ source: 'repair/warranty.md', document: 'Repair warranty' }],
          }),
        ],
      }),
    );
    expect(failed(checks)).toContain('retrieved:repair/warranty.md');
  });
  it('detects unrequested bookings and unoffered slots independently', () => {
    const actions = [
      {
        id: 'booking',
        kind: 'appointment',
        input: { provider: 'demo', start: '2030-01-01T09:00:00Z', end: '2030-01-01T10:00:00Z' },
      },
    ];
    const checks = checkConversationTurn({ user: 'Show times', expect: {} }, observation({ actions }));
    expect(failed(checks)).toContain('no-unrequested-booking');
    expect(failed(checks)).toContain('booking-uses-offered-slot');
    const offered = [{ start: '2030-01-01T09:00:00Z', end: '2030-01-01T10:00:00Z' }];
    expect(
      failed(
        checkConversationTurn(
          { user: 'Choose option 1', expect: { allowBooking: true } },
          observation({ actions, offeredSlotsBefore: offered }),
        ),
      ),
    ).toEqual([]);
  });
  it('rejects UTC clock values presented as local calendar availability', () => {
    const state = observation();
    state.session.snapshot.business!.calendarTimeZone = 'Asia/Yerevan';
    state.session.snapshot.business!.offeredSlots = [
      { start: '2030-01-01T05:00:00Z', end: '2030-01-01T06:00:00Z' },
    ];
    state.events = [event('tool.completed', { name: 'list_available_slots' })];
    state.answer = 'Available at 5:00 AM in Asia/Yerevan.';
    state.groundingContext = '5:00 9:00';
    expect(failed(checkConversationTurn({ user: 'Show times', expect: {} }, state))).toContain(
      'availability-times-use-calendar-zone',
    );
    state.answer = 'Available from 9:00 AM to 10:00 AM in Asia/Yerevan.';
    expect(failed(checkConversationTurn({ user: 'Show times', expect: {} }, state))).not.toContain(
      'availability-times-use-calendar-zone',
    );
  });
  it('does not confuse an absent interim outcome with a false repair-resolution claim', () => {
    expect(
      failed(checkConversationTurn({ user: 'Warranty?', expect: { unresolved: true } }, observation())),
    ).not.toContain('no-false-resolution');
  });
  it('does not accept a resolved approval card as a still-pending sensitive action', () => {
    const checks = checkConversationTurn(
      { user: 'Yes', expect: { pendingTool: 'cancel_appointment' } },
      observation({
        confirmations: [
          {
            id: 'confirmation',
            sessionId: 'evaluation',
            toolName: 'cancel_appointment',
            input: {},
            status: 'approved',
            expiresAt: '2030-01-01T00:00:00Z',
          },
        ],
      }),
    );
    expect(failed(checks)).toContain('approval-card-required');
  });
  it('requires a real retrieval refusal and stops automated responses after handoff', () => {
    expect(
      failed(checkConversationTurn({ user: 'Unknown?', expect: { refusal: true } }, observation())),
    ).toContain('unsupported-evidence');
    expect(
      failed(
        checkConversationTurn(
          { user: 'Unknown?', expect: { refusal: true } },
          observation({ events: [event('retrieval.completed', { status: 'insufficient', chunks: [] })] }),
        ),
      ),
    ).toEqual([]);
    expect(
      failed(
        checkConversationTurn(
          { user: 'Continue', expect: { silent: true } },
          observation({ answer: 'Here is more advice.' }),
        ),
      ),
    ).toContain('automation-stopped');
  });
});
