import { isRepairScenario, validateRepairBooking } from './repair-tools.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AppointmentRecord, ScenarioId, SupportSession } from './domain.js';
import type { ToolContext, ToolDefinition } from './tools.js';
import { getCalendarService, type CalendarBooking } from '../../integrations/src/calendar.js';

export const isBusinessScenario = (id: ScenarioId) =>
  isRepairScenario(id) || ['appointment-booking', 'lead-qualification', 'order-support'].includes(id);
export const businessIntent = (id: ScenarioId) =>
  isRepairScenario(id)
    ? ('repair_support' as const)
    : id === 'appointment-booking'
      ? ('appointment_booking' as const)
      : id === 'lead-qualification'
        ? ('lead_qualification' as const)
        : ('order_support' as const);
const short = z.string().trim().min(2).max(500);
function state(c: ToolContext, allowed: ScenarioId[]) {
  if (!allowed.includes(c.session.scenarioId) || !c.session.snapshot.business)
    throw new Error('This tool is not available in this scenario');
  return c.session.snapshot.business;
}
function define<T>(
  name: string,
  description: string,
  inputSchema: z.ZodType<T>,
  permission: 'read-only' | 'write' | 'sensitive-write',
  execute: ToolDefinition<T>['execute'],
): ToolDefinition<T> {
  return {
    name,
    description,
    inputSchema,
    permission,
    execute,
    jsonSchema: zodToJsonSchema(inputSchema, { $refStrategy: 'none' }) as Record<string, unknown>,
  };
}
const bookingScenarios: ScenarioId[] = [
  'appointment-booking',
  'lead-qualification',
  'repair-advice',
  'repair-booking',
  'repair-status',
];
export function createBusinessTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    define(
      'list_services',
      'List services and their appointment durations.',
      z.object({}).strict(),
      'read-only',
      async (_, c) => state(c, bookingScenarios).services,
    ),
    define(
      'list_available_slots',
      'Read available calendar slots for a service. Returns the provider, timezone and exact bookable intervals. Never invent availability.',
      z
        .object({
          serviceId: short,
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          partOfDay: z.enum(['morning', 'afternoon']).optional(),
        })
        .strict(),
      'read-only',
      async (input, c) => {
        const business = state(c, bookingScenarios);
        const service = business.services.find((s) => s.id === input.serviceId);
        if (!service) throw new Error('Unknown service');
        const result = await getCalendarService(c.session.mode ?? 'rehearsal').listSlots({
          date: input.date,
          durationMinutes: service.durationMinutes,
          days: input.date ? 1 : 7,
        });
        const persisted = (await c.repo.listCalendarReservations?.(result.provider)) ?? [];
        result.slots = result.slots.filter(
          (slot) =>
            !persisted.some(
              (busy) =>
                Date.parse(slot.start) < Date.parse(busy.end) &&
                Date.parse(slot.end) > Date.parse(busy.start),
            ),
        );
        if (input.partOfDay)
          result.slots = result.slots.filter((slot) => {
            const hour = Number(
              new Intl.DateTimeFormat('en-GB', {
                timeZone: result.timeZone,
                hour: '2-digit',
                hourCycle: 'h23',
              }).format(new Date(slot.start)),
            );
            return input.partOfDay === 'afternoon' ? hour >= 12 : hour < 12;
          });
        await c.repo.updateSession(c.session.id, {
          snapshot: {
            ...c.session.snapshot,
            business: {
              ...business,
              serviceId: service.id,
              offeredSlots: result.slots,
              calendarProvider: result.provider,
              calendarTimeZone: result.timeZone,
            },
          },
        });
        const localTime = new Intl.DateTimeFormat('en-GB', {
          timeZone: result.timeZone,
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        });
        const localDate = new Intl.DateTimeFormat('en-GB', {
          timeZone: result.timeZone,
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        });
        const displaySlots = result.slots.map((slot) => {
          const startLocal = localTime.format(new Date(slot.start));
          const endLocal = localTime.format(new Date(slot.end));
          return {
            ...slot,
            startLocal,
            endLocal,
            timeZone: result.timeZone,
            label: `${localDate.format(new Date(slot.start))}, ${startLocal}–${endLocal} (${result.timeZone})`,
          };
        });
        return { ...result, displaySlots, service };
      },
    ),
    define(
      'book_appointment',
      'Book a previously offered exact slot after the user explicitly chooses it. Google creates a real calendar event; demo creates a local booking only. Never claim an invite email was sent.',
      z
        .object({
          serviceId: short,
          start: z.string().datetime({ offset: true }),
          end: z.string().datetime({ offset: true }),
        })
        .strict(),
      'write',
      async (input, c) => {
        validateRepairBooking(c.session, input.serviceId);
        const business = state(c, bookingScenarios);
        const service = business.services.find((s) => s.id === input.serviceId);
        const matches = (value: Record<string, unknown>) =>
          value.serviceId === input.serviceId && value.start === input.start && value.end === input.end;
        const existing = (await c.repo.getActions(c.session.id)).find((a) => a.kind === 'appointment');
        if (existing) {
          const current = await c.repo.getAppointment?.(c.session.id);
          if (current?.status === 'cancelled')
            throw new Error('This appointment was cancelled. Start a new session to book another diagnosis.');
          if (current) {
            if (
              current.serviceId !== input.serviceId ||
              Date.parse(current.start) !== Date.parse(input.start) ||
              Date.parse(current.end) !== Date.parse(input.end)
            )
              throw new Error(
                'This session already has a different appointment; use the reschedule action to change it',
              );
            return {
              ...existing,
              input: {
                ...(existing.input as Record<string, unknown>),
                serviceId: current.serviceId,
                provider: current.provider,
                eventId: current.eventId,
                start: current.start,
                end: current.end,
                ...(current.htmlLink ? { htmlLink: current.htmlLink } : {}),
                appointmentId: current.id,
              },
            };
          }
          if (!matches(existing.input as Record<string, unknown>))
            throw new Error('This session already has a different appointment; request a human to change it');
          return existing;
        }
        if (business.pendingBooking && !matches(business.pendingBooking))
          throw new Error(
            'A previous booking needs verification. Retry the original slot before changing it',
          );
        if (
          !service ||
          (!business.pendingBooking &&
            (business.serviceId !== service.id ||
              !business.offeredSlots?.some((s) => s.start === input.start && s.end === input.end)))
        )
          throw new Error('Choose a slot from the latest availability results');
        await c.repo.updateSession(c.session.id, {
          snapshot: { ...c.session.snapshot, business: { ...business, pendingBooking: input } },
        });
        const customer = await c.repo.getCustomer(c.session.customerId);
        try {
          const calendar = getCalendarService(c.session.mode ?? 'rehearsal');
          const createBooking = () =>
            calendar.book({
              sessionId: c.session.id,
              bookingKey: 'appointment',
              start: input.start,
              end: input.end,
              summary: `${service.name} — ${customer.name}`,
              description: c.session.snapshot.repair
                ? `Relay repair demo ${c.session.id}. Appliance: ${c.session.snapshot.repair.appliance}. Model: ${c.session.snapshot.repair.model ?? 'not supplied'}. Reported symptom: ${c.session.snapshot.repair.issue}. ${input.serviceId === 'home-diagnosis' ? `Address: ${c.session.snapshot.repair.address}, ${c.session.snapshot.repair.region}.` : 'Workshop diagnosis appointment.'} This is a diagnosis appointment, not a promise of repair completion.`
                : `Relay demo session ${c.session.id}. ${business.lead?.need ?? 'Consultation requested through the demo.'}`,
            });
          let appointment: AppointmentRecord | undefined;
          let booking: CalendarBooking;
          if (c.repo.bookAppointment) {
            appointment = await c.repo.bookAppointment(
              c.session.id,
              {
                serviceId: input.serviceId,
                provider: calendar.status().provider,
                start: input.start,
                end: input.end,
              },
              async () => {
                const created = await createBooking();
                return {
                  serviceId: input.serviceId,
                  provider: created.provider,
                  eventId: created.eventId,
                  ...(created.htmlLink ? { htmlLink: created.htmlLink } : {}),
                  start: created.start,
                  end: created.end,
                };
              },
            );
            booking = {
              provider: appointment.provider,
              status: appointment.provider === 'google' ? 'confirmed' : 'demo',
              eventId: appointment.eventId,
              ...(appointment.htmlLink ? { htmlLink: appointment.htmlLink } : {}),
              start: appointment.start,
              end: appointment.end,
            };
          } else {
            booking = await createBooking();
            appointment = await c.repo.saveAppointment?.(c.session.id, {
              serviceId: input.serviceId,
              provider: booking.provider,
              eventId: booking.eventId,
              ...(booking.htmlLink ? { htmlLink: booking.htmlLink } : {}),
              start: booking.start,
              end: booking.end,
            });
          }
          return await c.repo.createAction(
            c.session.id,
            'appointment',
            {
              ...input,
              serviceName: service.name,
              ...booking,
              ...(appointment ? { appointmentId: appointment.id } : {}),
            },
            'business:appointment',
          );
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            ['SLOT_UNAVAILABLE', 'INVALID_SLOT', 'CONFIGURATION_ERROR', 'LIVE_UNAVAILABLE'].includes(
              String(error.code),
            )
          ) {
            const latest = await c.repo.getSession(c.session.id);
            await c.repo.updateSession(c.session.id, {
              snapshot: {
                ...latest.snapshot,
                business: { ...latest.snapshot.business!, pendingBooking: undefined },
              },
            });
          }
          throw error;
        }
      },
    ),
    define(
      'get_appointment',
      'Read the current persisted appointment, including its revision for a change approval. Optional ID must belong to this session owner.',
      z.object({ appointmentId: z.string().uuid().optional() }).strict(),
      'read-only',
      async ({ appointmentId }, c) => {
        state(c, bookingScenarios);
        if (!c.repo.getAppointment) throw new Error('Persistent appointments are unavailable');
        const appointment = await c.repo.getAppointment(c.session.id, appointmentId);
        if (!appointment) throw new Error('No appointment found for this session owner');
        return appointment;
      },
    ),
    define(
      'reschedule_appointment',
      'Propose moving the existing appointment to an exact returned available slot. Requires the application approval card; speech or model arguments cannot approve. Read get_appointment first and supply its expectedRevision. Confirmation rechecks availability and changes the same calendar event.',
      z
        .object({
          appointmentId: z.string().uuid().optional(),
          start: z.string().datetime({ offset: true }),
          end: z.string().datetime({ offset: true }),
          expectedRevision: z.number().int().min(1),
        })
        .strict(),
      'sensitive-write',
      async (input, c) => {
        const business = state(c, bookingScenarios);
        if (!c.repo.getAppointment || !c.repo.changeAppointment)
          throw new Error('Persistent appointments are unavailable');
        const appointment = await c.repo.getAppointment(c.session.id, input.appointmentId);
        if (!appointment) throw new Error('No appointment found for this session owner');
        if (
          business.serviceId !== appointment.serviceId ||
          !business.offeredSlots?.some((slot) => slot.start === input.start && slot.end === input.end)
        )
          throw new Error('Choose a slot from the latest availability results');
        const calendar = getCalendarService(c.session.mode ?? 'rehearsal');
        if (calendar.status().provider !== appointment.provider)
          throw new Error('Appointment provider does not match this session mode');
        const changed = await c.repo.changeAppointment(
          c.session.id,
          appointment.id,
          input.expectedRevision,
          { status: 'booked', start: input.start, end: input.end },
          async (record) => {
            await calendar.reschedule({
              sessionId: record.sessionId,
              bookingKey: 'appointment',
              eventId: record.eventId,
              previousStart: record.start,
              previousEnd: record.end,
              start: input.start,
              end: input.end,
            });
          },
        );
        await c.repo.createAction(
          c.session.id,
          'appointment-rescheduled',
          {
            appointmentId: changed.id,
            provider: changed.provider,
            start: changed.start,
            end: changed.end,
            revision: changed.revision,
          },
          `appointment:${changed.id}:rescheduled:${changed.revision}`,
        );
        return changed;
      },
    ),
    define(
      'cancel_appointment',
      'Propose cancellation of an existing appointment. Requires the application approval card, never a spoken yes. Read get_appointment first and bind the proposal to its current expectedRevision. Cancellation releases its time and updates the repair job.',
      z
        .object({ appointmentId: z.string().uuid().optional(), expectedRevision: z.number().int().min(1) })
        .strict(),
      'sensitive-write',
      async (input, c) => {
        state(c, bookingScenarios);
        if (!c.repo.getAppointment || !c.repo.changeAppointment)
          throw new Error('Persistent appointments are unavailable');
        const appointment = await c.repo.getAppointment(c.session.id, input.appointmentId);
        if (!appointment) throw new Error('No appointment found for this session owner');
        const calendar = getCalendarService(c.session.mode ?? 'rehearsal');
        if (calendar.status().provider !== appointment.provider)
          throw new Error('Appointment provider does not match this session mode');
        const changed = await c.repo.changeAppointment(
          c.session.id,
          appointment.id,
          input.expectedRevision,
          { status: 'cancelled' },
          async (record) => {
            await calendar.cancel({
              sessionId: record.sessionId,
              bookingKey: 'appointment',
              eventId: record.eventId,
              previousStart: record.start,
              previousEnd: record.end,
            });
          },
        );
        await c.repo.createAction(
          c.session.id,
          'appointment-cancelled',
          {
            appointmentId: changed.id,
            provider: changed.provider,
            status: 'cancelled',
            revision: changed.revision,
          },
          `appointment:${changed.id}:cancelled:${changed.revision}`,
        );
        return changed;
      },
    ),
    define(
      'save_lead',
      'Save a qualified lead locally after collecting the actual need, budget and timeline. This is a local lead record, not an external CRM sync.',
      z.object({ need: short, budget: short, timeline: short }).strict(),
      'write',
      async (input, c) => {
        const business = state(c, ['lead-qualification']);
        const existing = (await c.repo.getActions(c.session.id)).find((a) => a.kind === 'lead');
        if (existing) return existing;
        const customer = await c.repo.getCustomer(c.session.customerId);
        const action = await c.repo.createAction(
          c.session.id,
          'lead',
          { ...input, customerId: customer.id, name: customer.name, email: customer.email, storage: 'local' },
          'business:lead',
        );
        await c.repo.updateSession(c.session.id, {
          snapshot: { ...c.session.snapshot, business: { ...business, lead: input } },
        });
        return action;
      },
    ),
    define(
      'get_order',
      'Look up a fictional store order belonging to the customer bound to this session.',
      z.object({ orderId: short }).strict(),
      'read-only',
      async ({ orderId }, c) => {
        const business = state(c, ['order-support']);
        const order = business.orders.find(
          (o) => o.id.toUpperCase() === orderId.toUpperCase() && o.customerId === c.session.customerId,
        );
        if (!order) throw new Error('Order not found for this customer');
        await c.repo.updateSession(c.session.id, {
          snapshot: { ...c.session.snapshot, business: { ...business, selectedOrderId: order.id } },
        });
        return { ...order, source: 'fictional-demo' };
      },
    ),
    define(
      'request_delivery_change',
      'Persist a local delivery-change request for a previously verified order after the user confirms the exact new address. Fulfillment is not changed and an operator must review it.',
      z.object({ orderId: short, address: z.string().trim().min(8).max(500) }).strict(),
      'write',
      async (input, c) => {
        const business = state(c, ['order-support']);
        const order = business.orders.find(
          (o) => o.id === input.orderId && o.customerId === c.session.customerId,
        );
        if (!order || business.selectedOrderId !== order.id)
          throw new Error('Verify this customer order first');
        if (order.status !== 'processing')
          throw new Error('This order cannot be changed automatically; request a human operator');
        const existing = (await c.repo.getActions(c.session.id)).find((a) => a.kind === 'delivery-change');
        if (existing) return existing;
        return c.repo.createAction(
          c.session.id,
          'delivery-change',
          {
            ...input,
            originalAddress: order.deliveryAddress,
            status: 'pending-review',
            fulfillment: 'unchanged',
            storage: 'local',
          },
          'business:delivery-change',
        );
      },
    ),
  ];
  return tools.map((tool) => {
    if (!['reschedule_appointment', 'cancel_appointment'].includes(tool.name)) return tool;
    return {
      ...tool,
      prepare: async (input: any, c: ToolContext) => {
        const business = state(c, bookingScenarios);
        if (!c.repo.getAppointment) throw new Error('Persistent appointments are unavailable');
        const record = await c.repo.getAppointment(c.session.id, input.appointmentId);
        if (!record) throw new Error('No appointment found for this session owner');
        if (record.revision !== input.expectedRevision || record.status !== 'booked')
          throw new Error('Appointment changed; review its current details before confirming again');
        if (getCalendarService(c.session.mode ?? 'rehearsal').status().provider !== record.provider)
          throw new Error('Appointment provider does not match this session mode');
        const job = (await c.repo.listRepairJobs?.(c.session.id))?.find((j) => j.appointmentId === record.id);
        if (job && job.status !== 'scheduled')
          throw new Error('Diagnosis or repair has started; ask an operator before changing the appointment');
        if (
          tool.name === 'reschedule_appointment' &&
          (business.serviceId !== record.serviceId ||
            !business.offeredSlots?.some((slot) => slot.start === input.start && slot.end === input.end))
        )
          throw new Error('Choose a slot from the latest availability results');
        return { ...input, appointmentId: record.id };
      },
    };
  });
}

export async function validateBusinessOutcome(
  session: SupportSession,
  resolved: boolean,
  actions: Record<string, unknown>[],
) {
  if (!resolved) return;
  if (isRepairScenario(session.scenarioId)) {
    if (!actions.some((a) => a.kind === 'appointment'))
      throw new Error(
        'Cannot mark repair support resolved without a saved appointment; reading advice or status is not a repair',
      );
    return;
  }
  const requiredKind =
    session.scenarioId === 'appointment-booking'
      ? 'appointment'
      : session.scenarioId === 'lead-qualification'
        ? 'lead'
        : 'delivery-change';
  if (!actions.some((a) => a.kind === requiredKind))
    throw new Error(`Cannot mark complete without a saved ${requiredKind} record`);
  if (session.scenarioId === 'order-support')
    throw new Error('A delivery-change request is pending review; external fulfillment is not resolved');
}
