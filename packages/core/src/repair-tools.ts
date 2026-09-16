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
  permission: ToolDefinition<T>['permission'] = 'read-only',
): ToolDefinition<T> {
  return {
    name,
    description,
    inputSchema,
    execute,
    permission,
    jsonSchema: zodToJsonSchema(inputSchema, { $refStrategy: 'none' }) as Record<string, unknown>,
  };
}
export function createRepairTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [
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
          issue: z.string().trim().min(3).max(600).optional(),
          address: z.string().trim().min(8).max(500).optional(),
          region: z.string().trim().min(2).max(100).optional(),
          bookingRequested: z.boolean().optional(),
          contactName: z.string().trim().min(2).max(100).optional(),
          contactPhone: z.string().trim().min(5).max(40).optional(),
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
      'list_repair_jobs',
      'List persisted repair jobs accessible to this session owner, including booked diagnoses and their revision/history.',
      z.object({}).strict(),
      async (_, c) => {
        state(c);
        return c.repo.listRepairJobs ? c.repo.listRepairJobs(c.session.id) : state(c).jobs;
      },
    ),
    define(
      'approve_repair_quote',
      'Propose approval of the current repair quote. The application confirmation card is mandatory. Bind to the current job revision; never invent approval or start repairs without it.',
      z
        .object({
          jobId: z.string().trim().min(3).max(60),
          expectedRevision: z.number().int().min(1),
          expectedEstimateAMD: z.number().int().nonnegative(),
        })
        .strict(),
      async (input, c) => {
        state(c);
        if (!c.repo.getRepairJob || !c.repo.transitionRepairJob)
          throw new Error('Persistent repair jobs are unavailable');
        const job = await c.repo.getRepairJob(c.session.id, input.jobId);
        if (!job) throw new Error('Repair job not found for this session owner');
        if (job.estimateAMD !== input.expectedEstimateAMD)
          throw new Error('Repair quote changed; review the current amount before approval');
        const result = await c.repo.transitionRepairJob(
          c.session.id,
          input.jobId,
          {
            status: 'in_progress',
            note: 'Customer approved the repair quote using the application confirmation card.',
            expectedRevision: input.expectedRevision,
          },
          'customer',
        );
        await c.repo.createAction(
          c.session.id,
          'repair-quote-approved',
          {
            jobId: result.id,
            estimateAMD: result.estimateAMD,
            revision: result.revision,
            status: result.status,
          },
          `repair:${result.id}:approved:${result.revision}`,
        );
        return result;
      },
      'sensitive-write',
    ),
    define(
      'get_repair_status',
      'Look up a fictional repair job bound to this customer. Do not invent completion dates or parts stock. Never use documents as a live job status source.',
      z.object({ jobId: z.string().trim().min(3).max(60) }).strict(),
      async ({ jobId }, c) => {
        const repair = state(c);
        const job = c.repo.getRepairJob
          ? await c.repo.getRepairJob(c.session.id, jobId)
          : repair.jobs.find(
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
  return tools.map((tool) =>
    tool.name !== 'approve_repair_quote'
      ? tool
      : {
          ...tool,
          prepare: async (input: any, c: ToolContext) => {
            state(c);
            if (!c.repo.getRepairJob) throw new Error('Persistent repair jobs are unavailable');
            const job = await c.repo.getRepairJob(c.session.id, input.jobId);
            if (!job) throw new Error('Repair job not found for this session owner');
            if (job.status !== 'awaiting_approval' || job.revision !== input.expectedRevision)
              throw new Error('Repair job changed; review its current quote before confirming');
            if (job.estimateAMD === undefined || job.estimateAMD !== input.expectedEstimateAMD)
              throw new Error('Repair quote changed; review the current amount before approval');
            return { ...input, jobId: job.id, expectedEstimateAMD: job.estimateAMD };
          },
        },
  );
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
