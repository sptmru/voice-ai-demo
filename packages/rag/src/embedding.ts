import { resolve } from 'node:path';
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

/** Set RAG_EMBEDDING_MODEL to the legacy BGE model only for a separately reindexed comparison. */
export const EMBEDDING_MODEL = process.env.RAG_EMBEDDING_MODEL ?? 'Xenova/multilingual-e5-small';
if (!['Xenova/multilingual-e5-small', 'Xenova/bge-small-en-v1.5'].includes(EMBEDDING_MODEL))
  throw new Error('Unsupported RAG_EMBEDDING_MODEL; supported models both produce 384 dimensions');
export const EMBEDDING_DIMENSIONS = 384;
export const INFERENCE_THREADS = Math.max(
  1,
  Math.min(8, Math.floor(Number(process.env.RAG_INFERENCE_THREADS) || 2)),
);
export const EMBEDDING_POOLING = EMBEDDING_MODEL.includes('e5') ? 'mean' : 'cls';
export const EMBEDDING_SIGNATURE = `${EMBEDDING_MODEL}:q8:${EMBEDDING_POOLING}:384:v2`;
env.cacheDir = resolve(process.env.EMBEDDING_CACHE ?? process.env.EMBEDDING_CACHE_DIR ?? '.cache/models');
let extractorPromise: Promise<FeatureExtractionPipeline> | undefined;
const makeExtractor = pipeline as unknown as (
  task: 'feature-extraction',
  model: string,
  options: {
    dtype: 'q8';
    device: 'cpu';
    session_options: { intraOpNumThreads: number; interOpNumThreads: number };
  },
) => Promise<FeatureExtractionPipeline>;
function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise)
    extractorPromise = makeExtractor('feature-extraction', EMBEDDING_MODEL, {
      dtype: 'q8',
      device: 'cpu',
      session_options: { intraOpNumThreads: INFERENCE_THREADS, interOpNumThreads: 1 },
    }).catch((error) => {
      extractorPromise = undefined;
      throw error;
    });
  return extractorPromise;
}
export async function embed(text: string, isQuery = false): Promise<number[]> {
  const extractor = await getExtractor();
  const input =
    EMBEDDING_POOLING === 'mean'
      ? `${isQuery ? 'query' : 'passage'}: ${text}`
      : isQuery
        ? `Represent this sentence for searching relevant passages: ${text}`
        : text;
  const output = await extractor(input, { pooling: EMBEDDING_POOLING, normalize: true });
  const vector = Array.from(output.data as Float32Array);
  if (vector.length !== EMBEDDING_DIMENSIONS || vector.some((value) => !Number.isFinite(value)))
    throw new Error('Embedding model returned an invalid 384-dimensional vector');
  return vector;
}
