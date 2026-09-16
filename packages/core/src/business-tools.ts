import { isRepairScenario, validateRepairBooking } from './repair-tools.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ScenarioId, SupportSession } from './domain.js';
import type { ToolContext, ToolDefinition } from './tools.js';
import { CalendarError, getCalendarService } from '../../integrations/src/calendar.js';

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
  permission: 'read-only' | 'write',
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
  return [
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
        const result = await getCalendarService().listSlots({
          date: input.date,
          durationMinutes: service.durationMinutes,
          days: input.date ? 1 : 7,
        });
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
        return { ...result, service };
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
          const booking = await getCalendarService().book({
            sessionId: c.session.id,
            bookingKey: 'appointment',
            start: input.start,
            end: input.end,
            summary: `${service.name} — ${customer.name}`,
            description: c.session.snapshot.repair
              ? `Relay repair demo ${c.session.id}. Appliance: ${c.session.snapshot.repair.appliance}. Model: ${c.session.snapshot.repair.model ?? 'not supplied'}. Reported symptom: ${c.session.snapshot.repair.issue}. ${input.serviceId === 'home-diagnosis' ? `Address: ${c.session.snapshot.repair.address}, ${c.session.snapshot.repair.region}.` : 'Workshop diagnosis appointment.'} This is a diagnosis appointment, not a promise of repair completion.`
              : `Relay demo session ${c.session.id}. ${business.lead?.need ?? 'Consultation requested through the demo.'}`,
          });
          return await c.repo.createAction(
            c.session.id,
            'appointment',
            { ...input, serviceName: service.name, ...booking },
            'business:appointment',
          );
        } catch (error) {
          if (
            error instanceof CalendarError &&
            ['SLOT_UNAVAILABLE', 'INVALID_SLOT', 'CONFIGURATION_ERROR'].includes(error.code)
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
