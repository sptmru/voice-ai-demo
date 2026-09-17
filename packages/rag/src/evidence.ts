import { z } from 'zod';
import type {
  KnowledgeMetadata,
  RetrievalRequest,
  RetrievalResult,
  RetrievedChunk,
} from '../../core/src/domain.js';

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
    'Invalid calendar date',
  );
export const knowledgeMetadataSchema = z
  .object({
    domain: z.enum(['repair', 'general']).default('general'),
    version: z.string().trim().min(1).max(80).default('1'),
    policyKey: z.string().trim().min(1).max(120).optional(),
    status: z.enum(['active', 'archived']).default('active'),
    effectiveFrom: date.optional(),
    effectiveTo: date.optional(),
    appliance: z.string().trim().min(1).max(100).optional(),
    models: z.array(z.string().trim().min(1).max(100)).max(40).optional(),
  })
  .strict()
  .refine(
    (value) => !value.effectiveFrom || !value.effectiveTo || value.effectiveFrom <= value.effectiveTo,
    'Invalid effective date range',
  );
export function normalizeMetadata(input?: Partial<KnowledgeMetadata>): KnowledgeMetadata {
  return knowledgeMetadataSchema.parse(input ?? {});
}
export function isEffective(metadata: KnowledgeMetadata, asOf: string): boolean {
  return (
    metadata.status === 'active' &&
    (!metadata.effectiveFrom || metadata.effectiveFrom <= asOf) &&
    (!metadata.effectiveTo || metadata.effectiveTo >= asOf)
  );
}
export function canonicalKnowledgeModel(model?: string): string | undefined {
  if (!model) return undefined;
  return model.trim().match(/(?:^|\s)([a-z]+\d[a-z0-9-]*)$/iu)?.[1] ?? model.trim();
}
export function resolveRetrievalQuery(request: RetrievalRequest): { query: string; ambiguous: boolean } {
  const query = request.query.trim();
  const context = request.context
    ? { ...request.context, model: canonicalKnowledgeModel(request.context.model) }
    : undefined;
  const code = /(?:ошибк[а-я]*|error|code|код[а-я]*)\s*[:#-]?\s*([a-zа-я]{1,3}[- ]?\d{1,4})/iu.test(query);
  const namedModel = /\b(?:[a-z]{1,12}[- ]?)?\d{2,6}[a-z0-9-]*\b/iu.test(
    query.replace(/(?:ошибк[а-я]*|error|code|код[а-я]*)\s*[:#-]?\s*[a-zа-я]{1,3}[- ]?\d{1,4}/giu, ''),
  );
  if (code && !context?.model && !namedModel) return { query, ambiguous: true };
  const followup =
    /^(?:а\s|и\s|а\?|and\s|what about\s)|(?:\bthis\s+(?:model|one|appliance)|эта\s+модель|этой\s+(?:модели|техник)|для\s+не[её]|для\s+него)/iu.test(
      query,
    );
  const prior = context?.previousQuery ?? '';
  // Carry entities, not an entire old symptom: it otherwise overwhelms a short warranty question.
  const inheritedCode = /(?:этот\s+код|эта\s+ошибка|this\s+(?:code|error)|that\s+(?:code|error))/iu.test(
    query,
  )
    ? prior
        .match(/\b[A-Z]{1,3}[- ]?\d{1,4}\b/gu)
        ?.filter((token) => token !== context?.model)
        .join(' ')
    : undefined;
  const visit = /(?:visit|визит|приезд|выезд|fee|плат|подготов)/iu.test(query)
    ? prior
        .match(
          /(?:home(?:\s+diagnos\w+)?\s+visit|home\s+diagnos\w*|workshop|на\s+дом|выезд|мастерск[а-я]*)/giu,
        )
        ?.join(' ')
    : undefined;
  const known = [context?.appliance, context?.model, inheritedCode, visit].filter(Boolean);
  return {
    query: known.length ? `${query}\n${known.join(' · ')}`.slice(0, 2000) : query,
    ambiguous: followup && known.length === 0 && !prior,
  };
}
/** Metadata already scopes the appliance. Keep the latest question dominant during cross-encoding. */
export function resolveRerankingQuery(request: RetrievalRequest): string {
  if (!request.context) return request.query.trim();
  const needsModel = /(?:ошибк|код|error|\bcode\b|this\s+model|эта\s+модель|этой\s+модели)/iu.test(
    request.query,
  );
  if (needsModel) return resolveRetrievalQuery(request).query;
  return resolveRetrievalQuery({ ...request, context: { previousQuery: request.context.previousQuery } })
    .query;
}
/** A matching model name cannot establish an absent technical specification. */
export function hasRequestedMeasurement(query: string, content: string): boolean {
  const measurements: { request: RegExp; evidence: RegExp }[] = [
    {
      request: /(?:lit(?:re|er)s?|литр|\bcapacity\b|[её]мкост|объ[её]м)/iu,
      evidence:
        /\d+(?:[.,]\d+)?\s*(?:lit(?:re|er)s?|л(?:итр[а-я]*)?|kg|кг|килограмм[а-я]*)(?![\p{L}\p{N}])/iu,
    },
    {
      request: /(?:\bwatts?\b|ватт|мощност|power\s+(?:rating|consumption))/iu,
      evidence: /\d+(?:[.,]\d+)?\s*(?:k?w(?:atts?)?|к?вт|ватт[а-я]*)(?![\p{L}\p{N}])/iu,
    },
    {
      request: /(?:\bweight\b|сколько\s+весит|масса|вес\s)/iu,
      evidence: /\d+(?:[.,]\d+)?\s*(?:kg|g|lbs?|кг|г|килограмм[а-я]*)(?![\p{L}\p{N}])/iu,
    },
    {
      request: /(?:\bdimensions?\b|\bwidth\b|\bheight\b|габарит|ширин|высот)/iu,
      evidence: /\d+(?:[.,]\d+)?\s*(?:cm|mm|m|inches|см|мм|м)(?![\p{L}\p{N}])/iu,
    },
    {
      request: /(?:\bvoltage\b|напряжени[ея])/iu,
      evidence: /\d+(?:[.,]\d+)?\s*(?:v(?:olts?)?|в|вольт[а-я]*)(?![\p{L}\p{N}])/iu,
    },
  ];
  return measurements.every(({ request, evidence }) => !request.test(query) || evidence.test(content));
}
/** Relevance gates, not calibrated probabilities of correctness. Tune on the versioned evaluation set. */
export function assessEvidence(
  query: string,
  rewrittenQuery: string,
  candidates: RetrievedChunk[],
  limit = 5,
): RetrievalResult {
  const configuredSemantic = process.env.RAG_MIN_SEMANTIC_SCORE;
  const minRerank = Number(process.env.RAG_MIN_RERANK_SCORE ?? '0.12');
  const relevant = candidates.filter(
    (chunk) =>
      chunk.semanticScore >=
        Number(configuredSemantic ?? (chunk.rerankScore === undefined ? '0.76' : '0.70')) &&
      hasRequestedMeasurement(query, chunk.content) &&
      (chunk.rerankScore === undefined || chunk.rerankScore >= minRerank),
  );
  if (!relevant.length)
    return {
      status: 'insufficient',
      query,
      rewrittenQuery,
      chunks: [],
      reason:
        'No current source passed the relevance gates. Ask for the appliance/model or transfer to a specialist; do not infer an answer from nearby documents.',
    };
  const topPolicy = relevant[0].metadata?.policyKey;
  const versions = new Set(
    relevant
      .filter((chunk) => topPolicy && chunk.metadata?.policyKey === topPolicy)
      .map((chunk) => chunk.metadata?.version),
  );
  if (versions.size > 1)
    return {
      status: 'conflict',
      query,
      rewrittenQuery,
      chunks: relevant.filter((chunk) => chunk.metadata?.policyKey === topPolicy),
      reason:
        'Multiple effective versions of the same policy disagree on authority. A specialist must select the applicable version before answering.',
    };
  return {
    status: 'supported',
    query,
    rewrittenQuery,
    chunks: relevant.slice(0, limit),
    reason:
      'Current sources passed the relevance gates. Cite only facts explicitly contained in these excerpts; relevance does not prove every premise of the question.',
  };
}
