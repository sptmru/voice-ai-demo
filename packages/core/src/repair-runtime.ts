import { canonicalRepairModel } from './repair-tools.js';
import { getCalendarService } from '../../integrations/src/calendar.js';
import { requestedBusinessDate } from './business-runtime.js';
import type { CallOutcome, RepairState, Repository, RetrievedChunk, SupportSession } from './domain.js';

type RunTool = <T = any>(name: string, input?: unknown) => Promise<T>;
type Say = (text: string) => Promise<{ text: string }>;
const applianceName = (value?: string) =>
  ({
    'washing-machine': 'washing machine',
    dishwasher: 'dishwasher',
    refrigerator: 'refrigerator',
  })[value ?? ''] ?? 'appliance';
const slotLabel = (slot: { start: string }, timeZone: string) =>
  `${new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(slot.start))} (${timeZone})`;

/** No-key policy: quotations are evidence; a symptom is never a confirmed diagnosis. */
export async function repairMessage(
  session: SupportSession,
  text: string,
  repo: Repository,
  tool: RunTool,
  say: Say,
): Promise<{ text: string; outcome?: CallOutcome }> {
  const repair = session.snapshot.repair!;
  const save = async (patch: Partial<RepairState>) => {
    Object.assign(repair, patch);
    const current = await repo.getSession(session.id);
    await repo.updateSession(session.id, {
      snapshot: { ...current.snapshot, repair: { ...current.snapshot.repair!, ...repair } },
    });
  };
  const finish = (
    issue: string,
    diagnosis: string,
    resolved = false,
    nextAction = 'Ask an operator for clarification or book a diagnosis appointment.',
  ) =>
    tool<CallOutcome>('complete_support_case', {
      intent: 'repair_support',
      severity: 'low',
      product: 'Relay Workshop',
      issue,
      diagnosis,
      resolved,
      nextAction,
    });
  const context: Partial<RepairState> = {};
  if (/посудомо|dishwasher|\bD100\b/i.test(text)) context.appliance = 'dishwasher';
  else if (/стираль|стиралк|washing machine|\bW[12]00\b/i.test(text)) context.appliance = 'washing-machine';
  else if (/холодиль|fridge|refrigerator|\bC100\b/i.test(text)) context.appliance = 'refrigerator';
  const model =
    text.match(/\b(?:Relay\s+)?(?:Wash\s+|Dish\s+|Cool\s+)?[WDC][12]00\b/i)?.[0] ??
    text.match(/(?:модель|model)\s*[:]?\s*([A-Za-z0-9][A-Za-z0-9 -]{1,60})/i)?.[1];
  if (
    (context.appliance && repair.appliance && context.appliance !== repair.appliance) ||
    (model && repair.model && canonicalRepairModel(model) !== repair.model)
  ) {
    context.model = undefined;
    context.issue = undefined;
    context.previousQuery = undefined;
  }
  if (model) context.model = canonicalRepairModel(model);
  if (
    /не\s+(?:слива|работа|включ|охлажда|мороз|суш|гре|набира|отжима)|теч[её]т|протеч|ошибк|error|won.t|doesn.t|leak|not drain|not cool|not fill|not start|shakes|vibrat|неисправн|сломал/i.test(
      text,
    )
  )
    context.issue = text.slice(0, 500);
  const address = text.match(/(?:адрес|address)\s*:\s*(.{8,400})/i)?.[1]?.trim();
  if (address) {
    context.address = address;
    context.region = /^(?:ереван|yerevan)(?:[,\s]|$)/i.test(address) ? 'Yerevan' : undefined;
  } else if (/^(?:город\s*:\s*|я в\s+|нахожусь в\s+)?(?:ереван[е]?|yerevan)[.!\s]*$/i.test(text))
    context.region = 'Yerevan';
  if (/не (?:в )?ереван|outside yerevan|not in yerevan/i.test(text)) context.region = undefined;
  if (Object.keys(context).length) await save(context);

  if (/запах.{0,20}(?:гар|горел)|дым|искр|smoke|sparks|burning smell/i.test(text)) {
    await tool('request_human_handoff', {
      reason: 'Customer reports smoke, sparks or a burning smell: ' + text.slice(0, 500),
    });
    return say(
      'Stop using the appliance. Do not open its housing or touch wet wiring. Disconnect power if it is safe; contact emergency services if there is immediate danger. I have passed your description to an operator.',
    );
  }
  const pending = (await repo.getConfirmations(session.id)).find(
    (c) => c.status === 'pending' && Date.parse(c.expiresAt) > Date.now(),
  );
  if (pending && /^(?:yes|okay|ok|confirm|approve|да)\b/i.test(text))
    return say(
      'Please review and confirm the approval card. A typed or spoken reply cannot approve this action.',
    );
  if (/do not book|don't book|changed my mind|stop booking|never mind|не записывай/i.test(text)) {
    await save({ bookingRequested: false, rescheduling: false });
    return say(
      'I have stopped choosing a booking. No new appointment has been made. If you already have a booking, use its cancellation card to cancel it.',
    );
  }
  const jobId = text.match(/\bREP-[A-Z0-9]+\b/i)?.[0]?.toUpperCase();
  if (/(?:approve|accept|agree).{0,30}(?:quote|estimate|repair)|соглас.{0,20}смет/i.test(text)) {
    const id = jobId ?? repair.selectedJobId;
    if (!id) return say('Please provide the repair reference so I can show the current quote.');
    const job = await tool<any>('get_repair_status', { jobId: id });
    if (job.status !== 'awaiting_approval' || job.estimateAMD === undefined || !job.revision)
      return say(
        'There is no current quote awaiting approval for that repair. Ask an operator to review it.',
      );
    await tool('approve_repair_quote', {
      jobId: id,
      expectedRevision: job.revision,
      expectedEstimateAMD: job.estimateAMD,
    });
    return say(
      `Please review the approval card for repair ${id}: ${job.estimateAMD} AMD. The repair is not approved until you confirm the card.`,
    );
  }
  if (
    /(?:cancel|отмен).{0,30}(?:appointment|booking|visit|запис)|^(?:cancel|отмени)(?: it)?[.! ]*$/i.test(
      text,
    ) &&
    !/how|policy|what|как/i.test(text)
  ) {
    const appointment = await tool<any>('get_appointment');
    if (appointment.status === 'cancelled') return say('This appointment is already cancelled.');
    await tool('cancel_appointment', {
      appointmentId: appointment.id,
      expectedRevision: appointment.revision,
    });
    return say(
      'Please review the cancellation card. Your appointment remains booked until you confirm the cancellation.',
    );
  }
  const moveBooking =
    /reschedul|move.{0,25}(?:appointment|booking)|change.{0,20}(?:time|appointment)|перенес/i.test(text);
  if (moveBooking) await save({ rescheduling: true, bookingRequested: true });
  if (jobId || /статус|что с ремонт|готов.{0,12}ремонт|repair status|ready yet/i.test(text)) {
    const id = jobId ?? repair.selectedJobId;
    if (!id)
      return say('Please provide the repair reference. Fictional repair REP-1042 is available in this demo.');
    const job = await tool<RepairState['jobs'][number]>('get_repair_status', { jobId: id });
    const status: string =
      (
        {
          scheduled: 'diagnosis scheduled',
          diagnosing: 'being diagnosed',
          completed: 'completed',
          cancelled: 'cancelled',
          awaiting_approval: 'awaiting quote approval',
          in_progress: 'in progress',
          ready: 'ready for collection',
        } as Record<string, string>
      )[job.status] ?? job.status;
    const reply = `Demo repair ${job.id}, ${job.model}: ${status}. ${job.note}${job.estimateAMD !== undefined ? ` Quote: ${job.estimateAMD} AMD${job.diagnosisCreditAMD ? `, the previously paid ${job.diagnosisCreditAMD} AMD diagnosis fee is credited if you approve the repair; remaining estimate ${job.estimateAMD - job.diagnosisCreditAMD} AMD` : ''}.` : ''} ${job.readyAt ? `Recorded completion date: ${job.readyAt}.` : 'No confirmed completion date.'} This is fictional demo data.`;
    await finish(
      'Repair status check',
      reply,
      false,
      'Approve the quote with an operator; parts availability and timing require separate confirmation.',
    );
    return say(reply);
  }
  if (
    /стоимост|цен[аыу]|price|cost|каталог|(?:сколько.{0,15}(?:стоит|стоят|платить|денег))/i.test(text) &&
    !/гаранти|warranty/i.test(text)
  ) {
    const catalog = await tool<{ services: RepairState['services'] }>('get_repair_catalog');
    const reply = `Relay Workshop demo prices: ${catalog.services.map((s) => `${s.name} — ${s.priceAMD} AMD${s.creditAgainstRepair ? ' (credited toward an approved repair)' : ' (payable even if you decline repair; not credited toward repair)'}`).join('; ')}. The repair price is quoted after diagnosis and approved before work begins. Live parts availability is not connected.`;
    await finish('Diagnosis pricing', reply);
    return say(reply);
  }
  const selection = text.match(
    /^(?:book|choose|select|запиши|выбираю)\s+(?:(?:option|slot|вариант)\s*)?([1-9]\d?)[.!\s]*$/i,
  )?.[1];
  const bookingIntent =
    /запис|запиш|свободн.{0,15}врем|доступн.{0,15}врем|выезд|на дом|book|appointment|available (?:time|slot)|home visit/i.test(
      text,
    );
  const knowledgeIntent =
    /гаранти|подготов|услови|возврат|отмен|warranty|prepare|policy|cancel|что делать|как /i.test(text);
  const booking =
    !!selection ||
    bookingIntent ||
    (!knowledgeIntent && (repair.bookingRequested || session.scenarioId === 'repair-booking'));
  if (booking) {
    await save({ bookingRequested: true });
    if (!repair.appliance)
      return say(
        'Which appliance needs diagnosis: a washing machine, dishwasher or refrigerator? Please include the model if you know it.',
      );
    if (!repair.issue)
      return say(
        `What happened to your ${applianceName(repair.appliance)}? Describe the symptom or error code. You can read the model from its label without opening the housing.`,
      );
    const current = await repo.getSession(session.id);
    const business = current.snapshot.business!;
    const appointment = await repo.getAppointment?.(session.id);
    const prior = (await repo.getActions(session.id)).find((a) => a.kind === 'appointment');
    if (appointment?.status === 'cancelled')
      return say('Your appointment is cancelled. Start a new conversation to arrange a new diagnosis.');
    if ((appointment || prior) && !repair.rescheduling) {
      const record = appointment ?? (prior!.input as Record<string, unknown>);
      return say(
        `${record.provider === 'google' ? 'Booking confirmed in Google Calendar' : 'Local demo booking saved'}: ${slotLabel({ start: String(record.start) }, business.calendarTimeZone ?? 'Asia/Yerevan')}. You can ask to reschedule or cancel it. This is a diagnosis appointment, without a promised repair completion date.`,
      );
    }
    const serviceId = /на дом|выезд|home visit/i.test(text)
      ? 'home-diagnosis'
      : /мастерск|workshop/i.test(text)
        ? 'workshop-diagnosis'
        : (business.serviceId ?? 'workshop-diagnosis');
    if (
      serviceId === 'home-diagnosis' &&
      (!repair.address || !/^(yerevan|ереван)$/i.test(repair.region ?? ''))
    ) {
      await repo.updateSession(session.id, {
        snapshot: { ...current.snapshot, business: { ...business, serviceId } },
      });
      return say(
        'Home visits are available only within Yerevan. Provide "Address: Yerevan, street, building, apartment". The visit and diagnosis cost 8000 AMD, payable even if you decline repair and not credited toward repair.',
      );
    }
    if (selection) {
      const slot = business.offeredSlots?.[Number(selection) - 1];
      if (!slot || Number(selection) > 5)
        return say('First ask for available times, then choose one of the offered options.');
      if (repair.rescheduling) {
        const record = appointment ?? (await tool<any>('get_appointment'));
        await tool('reschedule_appointment', {
          appointmentId: record.id,
          expectedRevision: record.revision,
          ...slot,
        });
        await save({ rescheduling: false });
        return say(
          `Please confirm the rescheduling card for ${slotLabel(slot, business.calendarTimeZone ?? 'Asia/Yerevan')}. The existing appointment has not changed yet.`,
        );
      }
      const action = await tool<Record<string, unknown>>('book_appointment', { serviceId, ...slot });
      const record = action.input as Record<string, unknown>;
      const reply = `${record.provider === 'google' ? 'Booking confirmed in Google Calendar' : 'Local demo booking saved'}: ${slotLabel(slot, business.calendarTimeZone ?? 'Asia/Yerevan')}. ${record.provider === 'demo' ? 'No external calendar event was created. ' : ''}This is a diagnosis appointment, not a promised repair completion time.`;
      const outcome = await finish(
        'Appliance diagnosis booking',
        reply,
        true,
        'Attend diagnosis or expect the agreed visit; the quote and repair require separate approval.',
      );
      await say(reply);
      return { text: reply, outcome };
    }
    const date = requestedBusinessDate(
      text,
      getCalendarService(session.mode ?? 'rehearsal').status().timeZone,
    );
    const partOfDay = /после обеда|днем|днём|afternoon/i.test(text)
      ? 'afternoon'
      : /утр|morning/i.test(text)
        ? 'morning'
        : undefined;
    const result = await tool<{
      provider: string;
      timeZone: string;
      slots: { start: string; end: string }[];
      service: { name: string };
    }>('list_available_slots', { serviceId, ...(date ? { date } : {}), ...(partOfDay ? { partOfDay } : {}) });
    if (!result.slots.length)
      return say('No times are available for that date. Please choose another date in YYYY-MM-DD format.');
    return say(
      `${result.service.name}. ${result.provider === 'google' ? 'Connected calendar availability' : 'Local demo availability'}: ${result.slots
        .slice(0, 5)
        .map((slot, index) => `${index + 1}. ${slotLabel(slot, result.timeZone)}`)
        .join(
          '; ',
        )}. Say "Choose option 1" or another offered number to book. The appointment lasts 60 minutes; this is not the repair completion time.`,
    );
  }
  const result = await tool<{ status: string; reason?: string; chunks: RetrievedChunk[] }>(
    'search_knowledge_base',
    { query: text.slice(0, 1000), limit: 4 },
  );
  if (result.status !== 'supported' || !result.chunks.length) {
    const reply =
      result.status === 'conflict'
        ? 'The sources contain conflicting policies. An operator needs to clarify which terms apply.'
        : result.status === 'clarify'
          ? 'Please specify the appliance type and model so I can find the right guidance.'
          : 'The current documents do not provide enough evidence to answer. I can help book diagnosis or pass the question to an operator.';
    await finish(text, reply);
    return say(reply);
  }
  // Extractive fallback makes the support visible and avoids making up a diagnosis.
  const first = result.chunks[0];
  const passage =
    result.chunks.find((chunk) => chunk.documentId === first.documentId && !/[а-яё]/i.test(chunk.content)) ??
    first;
  const chunks = [passage];
  const reply =
    chunks
      .map((chunk) => `According to "${chunk.document}", section "${chunk.section}": ${chunk.content}`)
      .join('\n\n') + '\nThis is general guidance. A technician must diagnose the fault and provide a quote.';
  await finish(
    text,
    `Shared source excerpts: ${chunks.map((c) => c.document + ' — ' + c.section).join('; ')}. The fault and repair remain unconfirmed.`,
  );
  return say(reply);
}
