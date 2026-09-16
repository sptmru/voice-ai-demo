import { getCalendarService } from '../../integrations/src/calendar.js';
import type { BusinessState, CallOutcome, Repository, SupportSession } from './domain.js';
import { businessIntent } from './business-tools.js';

type RunTool = <T = any>(name: string, input?: unknown) => Promise<T>;
type Say = (text: string) => Promise<{ text: string }>;
const actionInput = (action: Record<string, unknown>) => action.input as Record<string, unknown>;
function slotLabel(slot: { start: string; end: string }, timeZone: string) {
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${format.format(new Date(slot.start))} (${timeZone})`;
}

export function requestedBusinessDate(text: string, timeZone: string, now = new Date()): string | undefined {
  const explicit = text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  if (explicit) return explicit;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: string) => parts.find((p) => p.type === type)!.value;
  const day = new Date(`${value('year')}-${value('month')}-${value('day')}T12:00:00Z`);
  if (/tomorrow|завтра/i.test(text)) day.setUTCDate(day.getUTCDate() + 1);
  else if (/friday|пятниц/i.test(text))
    day.setUTCDate(day.getUTCDate() + ((5 - day.getUTCDay() + 7) % 7 || 7));
  else return undefined;
  return day.toISOString().slice(0, 10);
}

/** Explicit no-key conversation policy. It collects values; it never invents customer answers. */
export async function businessMessage(
  session: SupportSession,
  text: string,
  repo: Repository,
  tool: RunTool,
  say: Say,
): Promise<{ text: string; outcome?: CallOutcome }> {
  const business = session.snapshot.business!;
  const actions = await repo.getActions(session.id);
  const save = async (patch: Partial<BusinessState>) => {
    Object.assign(business, patch);
    await repo.updateSession(session.id, { snapshot: { ...session.snapshot, business } });
  };
  const finish = async (issue: string, diagnosis: string, resolved: boolean, nextAction: string) =>
    tool<CallOutcome>('complete_support_case', {
      intent: businessIntent(session.scenarioId),
      severity: 'low',
      product: session.scenarioId === 'order-support' ? 'Demo store' : 'Consulting',
      issue,
      diagnosis,
      resolved,
      nextAction,
    });
  if (session.scenarioId === 'order-support') {
    const prior = actions.find((a) => a.kind === 'delivery-change');
    if (prior)
      return say(
        `Delivery-change request ${prior.id} is saved locally for ${actionInput(prior).address}. An operator must review it; the actual delivery remains unchanged.`,
      );
    const orderId = text.match(/\bORD-[A-Z0-9]+\b/i)?.[0]?.toUpperCase() ?? business.selectedOrderId;
    if (!orderId)
      return say(
        'Please provide your order number. This scenario has fictional order ORD-1042 for the demo customer.',
      );
    const order = await tool<{
      id: string;
      status: string;
      estimatedDelivery: string;
      deliveryAddress: string;
    }>('get_order', { orderId });
    const address = text
      .match(
        /(?:change (?:the )?delivery to|deliver to|new address\s*:?|адрес\s*:|достав(?:ить|ку) (?:по адресу|на))\s*(.{8,500})/i,
      )?.[1]
      ?.trim();
    if (address) {
      await save({ selectedOrderId: order.id, pendingDeliveryAddress: address });
      return say(
        `Create a local delivery-change request for ${order.id} to "${address}"? Reply "Confirm delivery change". The store will still need to review the request.`,
      );
    }
    if (
      /^(confirm delivery change|подтверждаю изменение доставки|yes|да)[.!\s]*$/i.test(text) &&
      business.pendingDeliveryAddress
    ) {
      const action = await tool<Record<string, unknown>>('request_delivery_change', {
        orderId: order.id,
        address: business.pendingDeliveryAddress,
      });
      const diagnosis = `Delivery-change request ${action.id} saved locally for ${business.pendingDeliveryAddress}; fulfillment remains unchanged.`;
      const outcome = await finish(
        'Delivery change requested',
        diagnosis,
        false,
        'An operator must review the request and confirm the delivery change.',
      );
      await say(diagnosis + ' An operator must review and confirm the change.');
      return { text: diagnosis, outcome };
    }
    if (/^(cancel|no|нет|отмена)[.!\s]*$/i.test(text)) {
      await save({ pendingDeliveryAddress: undefined });
      return say('The proposed delivery request was cancelled. Your delivery address remains unchanged.');
    }
    return say(
      `Fictional demo order ${order.id} is ${order.status}. Delivery: ${order.estimatedDelivery}. Address: ${order.deliveryAddress}. To request a change, say "Change delivery to" followed by the full address.`,
    );
  }

  const priorBooking = actions.find((a) => a.kind === 'appointment');
  if (priorBooking) {
    const record = actionInput(priorBooking);
    return say(
      `${record.provider === 'google' ? 'Your calendar event is confirmed' : 'Your local demo booking is saved'} for ${slotLabel({ start: String(record.start), end: String(record.end) }, business.calendarTimeZone ?? 'UTC')}. ${record.provider === 'demo' ? 'No external calendar event was created.' : 'You can review it in the connected calendar.'}`,
    );
  }
  if (session.scenarioId === 'lead-qualification' && !actions.some((a) => a.kind === 'lead')) {
    const lead = { ...business.lead };
    for (const [field, words] of [
      ['need', 'need|задача'],
      ['budget', 'budget|бюджет'],
      ['timeline', 'timeline|срок'],
    ] as const) {
      const value = text
        .match(new RegExp(`(?:^|[;\\n])\\s*(?:${words})\\s*:\\s*([^;\\n]+)`, 'i'))?.[1]
        ?.trim();
      if (value && value.length >= 2) lead[field] = value;
    }
    // A natural first message may describe the need; remaining fields must be explicit or sequential answers.
    if (
      !lead.need &&
      !text.includes('?') &&
      (/(?:want|need|looking for|нужен|нужно|хотим|хочу).{5,}/i.test(text) ||
        (business.lead && text.trim().length >= 8 && !/budget|timeline|бюджет|срок/i.test(text)))
    )
      lead.need = text.slice(0, 500);
    if (
      business.lead?.need &&
      !business.lead.budget &&
      !lead.budget &&
      /\d|tbd|undecided|не определ|не знаю/i.test(text) &&
      !/timeline|срок/i.test(text)
    )
      lead.budget = text.slice(0, 500);
    else if (
      business.lead?.need &&
      business.lead.budget &&
      !business.lead.timeline &&
      !lead.timeline &&
      !text.includes('?') &&
      /(?:now|asap|today|tomorrow|next|week|month|year|quarter|day|spring|summer|autumn|winter|tbd|undecided|not sure|january|february|march|april|may|june|july|august|september|october|november|december|сейчас|скорее|завтра|недел|месяц|год|квартал|дней|дня|весн|летом|осен|зим|не знаю|не определ|\d{4})/i.test(
        text,
      )
    )
      lead.timeline = text.slice(0, 500);
    await save({ lead });
    if (!lead.need)
      return say(
        'What business task should the agent handle? You can provide "Need: ...; Budget: ...; Timeline: ..." in one message.',
      );
    if (!lead.budget) return say('What budget have you allocated? An estimate or "undecided" is fine.');
    if (!lead.timeline) return say('When would you like to launch?');
    const action = await tool<Record<string, unknown>>('save_lead', lead);
    const diagnosis = `Lead ${action.id} saved locally. Need: ${lead.need}. Budget: ${lead.budget}. Timeline: ${lead.timeline}.`;
    const outcome = await finish(
      'Qualified project inquiry',
      diagnosis,
      true,
      'Review the saved lead; optionally book a discovery meeting.',
    );
    await say(
      diagnosis +
        ' Say "Book a meeting" to see available consultation times. This record has not been sent to an external CRM.',
    );
    return { text: diagnosis, outcome };
  }
  if (
    session.scenarioId === 'lead-qualification' &&
    !/book|meeting|time|slot|option|встреч|запис|врем|вариант/i.test(text)
  )
    return say(
      'Your lead is saved locally. Say "Book a meeting" to choose a consultation time, or ask to talk to a person.',
    );

  const serviceId = /implementation|planning|внедрен/i.test(text)
    ? 'implementation'
    : (business.serviceId ?? 'consultation');
  const selection = text.match(
    /^(?:book|choose|select|запиши|выбираю)\s+(?:(?:option|slot|вариант)\s*)?([1-9]\d?)[.!\s]*$/i,
  )?.[1];
  if (selection) {
    const slot = business.offeredSlots?.[Number(selection) - 1];
    if (!slot)
      return say(
        'Please choose an option from the offered times. Say "Show available times" to refresh them.',
      );
    const action = await tool<Record<string, unknown>>('book_appointment', { serviceId, ...slot });
    const record = actionInput(action);
    const diagnosis = `${record.provider === 'google' ? 'Calendar event confirmed' : 'Local demo booking saved'} for ${slotLabel(slot, business.calendarTimeZone ?? 'UTC')}.`;
    const outcome = await finish(
      'Consultation booked',
      diagnosis,
      true,
      record.provider === 'google'
        ? 'Attend the appointment shown in the connected calendar.'
        : 'Demo booking only; connect Google Calendar to create an external event.',
    );
    await say(
      diagnosis +
        (record.provider === 'demo'
          ? ' No external calendar event was created.'
          : ' The event is available in the connected calendar.'),
    );
    return { text: diagnosis, outcome };
  }
  const date = requestedBusinessDate(text, getCalendarService().status().timeZone);
  const partOfDay = /after ?noon|afternoon|после обеда|днём|днем/i.test(text)
    ? 'afternoon'
    : /morning|утр/i.test(text)
      ? 'morning'
      : undefined;
  const result = await tool<{
    provider: string;
    timeZone: string;
    slots: { start: string; end: string }[];
    service: { name: string };
  }>('list_available_slots', { serviceId, ...(date ? { date } : {}), ...(partOfDay ? { partOfDay } : {}) });
  if (!result.slots.length)
    return say('There are no available times for that date. Please provide another date (YYYY-MM-DD).');
  return say(
    `${result.service.name}. ${result.provider === 'google' ? 'Connected calendar availability' : 'Local demo availability'}: ${result.slots
      .slice(0, 5)
      .map((slot, index) => `${index + 1}. ${slotLabel(slot, result.timeZone)}`)
      .join(
        '; ',
      )}. Say "Book option 1" (or another shown option) to confirm. You can also request "Implementation planning" or a date (YYYY-MM-DD).`,
  );
}
