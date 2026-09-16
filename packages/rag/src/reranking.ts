import { AutoModelForSequenceClassification, AutoTokenizer } from '@huggingface/transformers';
import { INFERENCE_THREADS } from './embedding.js';
import type { RetrievedChunk } from '../../core/src/domain.js';

// Official Sentence Transformers cross-encoder: query and passage are jointly encoded.
// https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1
export const RERANKER_MODEL = 'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1';
export const RERANKER_ENABLED = process.env.RAG_RERANKER !== 'off';
let resources: Promise<{ tokenizer: any; model: any }> | undefined;
function load() {
  resources ??= Promise.all([
    AutoTokenizer.from_pretrained(RERANKER_MODEL),
    AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL, {
      // The official repository uses this explicit filename instead of model_quantized.onnx.
      model_file_name: 'model_quint8_avx2',
      dtype: 'fp32',
      device: 'cpu',
      session_options: { intraOpNumThreads: INFERENCE_THREADS, interOpNumThreads: 1 },
    }),
  ])
    .then(([tokenizer, model]) => ({ tokenizer, model }))
    .catch((error) => {
      resources = undefined;
      throw error;
    });
  return resources;
}
export async function warmReranker(): Promise<void> {
  if (RERANKER_ENABLED) await load();
}
export async function rerank(query: string, chunks: RetrievedChunk[]): Promise<RetrievedChunk[]> {
  if (!RERANKER_ENABLED || chunks.length === 0) return chunks;
  const { tokenizer, model } = await load();
  const scored: RetrievedChunk[] = [];
  // Four pairs per batch amortize inference overhead without a large padding allocation.
  for (let offset = 0; offset < Math.min(chunks.length, 12); offset += 4) {
    const batch = chunks.slice(offset, offset + 4);
    const inputs = tokenizer(
      batch.map(() => query),
      {
        text_pair: batch.map((chunk) => `${chunk.document}\n${chunk.section}\n${chunk.content}`),
        padding: true,
        truncation: true,
        max_length: 512,
      },
    );
    const output = await model(inputs);
    for (const [index, chunk] of batch.entries()) {
      const logit = Number(output.logits.data[index]);
      if (!Number.isFinite(logit)) throw new Error('Reranker returned a non-finite relevance score');
      scored.push({ ...chunk, rerankScore: 1 / (1 + Math.exp(-logit)) });
    }
  }
  return scored.sort(
    (a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0) || b.combinedScore - a.combinedScore,
  );
}
