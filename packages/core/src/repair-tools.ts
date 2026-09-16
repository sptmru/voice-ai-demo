import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { RepairState, ScenarioId } from './domain.js';
import type { ToolContext, ToolDefinition } from './tools.js';

export const canonicalRepairModel = (model: string) =>
  model.match(/\b[WDC][12]00\b/i)?.[0]?.toUpperCase() ?? model.trim();
export const isRepairScenario = (id: ScenarioId) => id.startsWith('repair-');
const state = (c: ToolContext): RepairState => {
  if (!isRepairScenario(c.session.scenarioId) || !c.session.snapshot.repair)
    throw new Error('This tool is only available in appliance repair scenarios');
  return c.session.snapshot.repair;
};
function define<T>(
  name: string,
  description: string,
  inputSchema: z.ZodType<T>,
  execute: ToolDefinition<T>['execute'],
): ToolDefinition<T> {
  return {
    name,
    description,
    inputSchema,
    execute,
    permission: 'read-only',
    jsonSchema: zodToJsonSchema(inputSchema, { $refStrategy: 'none' }) as Record<string, unknown>,
  };
}
export function createRepairTools(): ToolDefinition[] {
  return [
    define(
      'get_repair_catalog',
      'Read the authoritative fictional demo service catalog and AMD diagnosis prices. Repair labor/parts totals require diagnosis and customer approval. No live parts inventory is connected.',
      z.object({}).strict(),
      async (_, c) => ({
        business: 'Relay Workshop',
        source: 'fictional-demo',
        currency: 'AMD',
        services: state(c).services,
        homeServiceRegion: 'Yerevan',
        repairPrice: 'Quoted after diagnosis; explicit approval required',
        partsAvailability: 'unknown',
        homeFee: '8000 AMD payable even when repair is declined; not credited toward repair',
        workshopFee: '5000 AMD credited against accepted repair',
      }),
    ),
    define(
      'update_repair_context',
      'Remember only appliance, model, symptom and booking location explicitly supplied by the current customer. Never invent missing values. Does not create a booking.',
      z
        .object({
          appliance: z.enum(['washing-machine', 'dishwasher', 'refrigerator']).optional(),
          model: z.string().trim().min(2).max(100).optional(),
          issue: z.string().trim().min(3).max(500).optional(),
          address: z.string().trim().min(8).max(500).optional(),
          region: z.string().trim().min(2).max(100).optional(),
        })
        .strict(),
      async (input, c) => {
        if (input.model) input.model = canonicalRepairModel(input.model);
        if (input.region && /^(yerevan|ереван)$/i.test(input.region)) input.region = 'Yerevan';
        const prior = state(c);
        const reset =
          (input.appliance && input.appliance !== prior.appliance) ||
          (input.model && input.model !== prior.model)
            ? { model: undefined, issue: undefined, previousQuery: undefined }
            : {};
        const repair = { ...prior, ...reset, ...input };
        await c.repo.updateSession(c.session.id, { snapshot: { ...c.session.snapshot, repair } });
        const { jobs: _, services: __, ...context } = repair;
        return context;
      },
    ),
    define(
      'get_repair_status',
      'Look up a fictional repair job bound to this customer. Do not invent completion dates or parts stock. Never use documents as a live job status source.',
      z.object({ jobId: z.string().trim().min(3).max(60) }).strict(),
      async ({ jobId }, c) => {
        const repair = state(c);
        const job = repair.jobs.find(
          (j) => j.id.toUpperCase() === jobId.toUpperCase() && j.customerId === c.session.customerId,
        );
        if (!job) throw new Error('Repair job not found for this customer');
        await c.repo.updateSession(c.session.id, {
          snapshot: { ...c.session.snapshot, repair: { ...repair, selectedJobId: job.id } },
        });
        return { ...job, source: 'fictional-demo', partsAvailability: 'unknown' };
      },
    ),
  ];
}

export function validateRepairBooking(session: ToolContext['session'], serviceId: string) {
  const repair = session.snapshot.repair;
  if (!isRepairScenario(session.scenarioId)) return;
  if (/дым|искр|запах.{0,20}(?:гар|горел)|smoke|spark|burning smell/i.test(repair?.issue ?? ''))
    throw new Error('A potentially dangerous symptom requires operator review before booking');
  if (!repair?.appliance || !repair.issue)
    throw new Error('Provide the appliance type and symptom before booking');
  if (serviceId === 'home-diagnosis' && (!repair.address || !/^(yerevan|ереван)$/i.test(repair.region ?? '')))
    throw new Error('Provide the full address and confirm Yerevan for a home visit');
}
