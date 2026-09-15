import { resolve } from 'node:path';
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

export const EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5';
export const EMBEDDING_DIMENSIONS = 384;
env.cacheDir = resolve(process.env.EMBEDDING_CACHE ?? process.env.EMBEDDING_CACHE_DIR ?? '.cache/models');

let extractorPromise: Promise<FeatureExtractionPipeline> | undefined;
const makeExtractor = pipeline as unknown as (
  task: 'feature-extraction',
  model: string,
  options: { dtype: 'q8'; device: 'cpu' },
) => Promise<FeatureExtractionPipeline>;
function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = makeExtractor('feature-extraction', EMBEDDING_MODEL, {
      dtype: 'q8',
      device: 'cpu',
    }).catch((error) => {
      extractorPromise = undefined;
      throw error;
    });
  }
  return extractorPromise;
}

/** BGE uses normalized CLS pooling and the retrieval instruction on queries only. */
export async function embed(text: string, isQuery = false): Promise<number[]> {
  const extractor = await getExtractor();
  const input = isQuery ? `Represent this sentence for searching relevant passages: ${text}` : text;
  const output = await extractor(input, { pooling: 'cls', normalize: true });
  const vector = Array.from(output.data as Float32Array);
  if (vector.length !== EMBEDDING_DIMENSIONS || vector.some((value) => !Number.isFinite(value)))
    throw new Error('Embedding model returned an invalid 384-dimensional vector');
  return vector;
}
