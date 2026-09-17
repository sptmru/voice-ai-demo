# RAG for the appliance repair demo

## Knowledge corpus

`docs/knowledge/repair/manifest.json` provides metadata for 16 active English documents and an archived warranty. These are fictional workshop policies and fictional Relay appliances, not real manufacturer instructions. Prices, jobs and calendar availability come from operational tools; documents describe the policies governing them. Multilingual embeddings support Russian queries against the English corpus.

Metadata fields: `domain`, `version`, `policyKey`, `status`, `effectiveFrom`, `effectiveTo`, `appliance`, `models`. Effective dates are inclusive. `policyKey` groups versions of one policy. Multiple relevant active versions produce `conflict`; the system does not automatically choose the lexicographically greatest version. This detects ambiguous metadata authority, not arbitrary contradictions in natural language.

In **Knowledge base**, choose a domain, upload PDF/Markdown/TXT and optionally expand the metadata JSON editor. For example:

```json
{
  "domain": "repair",
  "version": "2026.10",
  "policyKey": "repair-warranty",
  "status": "active",
  "effectiveFrom": "2026-10-01"
}
```

To replace a policy, delete its prior document or upload the same original file with `status: "archived"`: its content hash and filename produce the same source, so metadata is updated. A changed file becomes a separate document. Seed updates built-in sources at stable paths and preserves user uploads.

## Retrieval flow

1. `search_knowledge_base` receives the server-owned `repair` domain and appliance, model and previous-question context. Short follow-ups inherit entities; an old symptom does not replace the current warranty question.
2. Filtering excludes archived, future, expired and incompatible-model passages. General policies remain available. Vectors with a different embedding signature are never compared.
3. [Multilingual E5 small](https://huggingface.co/Xenova/multilingual-e5-small) produces normalized 384-dimensional vectors with mean pooling and `query:` / `passage:` prefixes. PostgreSQL combines cosine search with English/Russian full text through reciprocal-rank fusion.
4. Up to 12 candidates are reranked by a real [multilingual cross-encoder](https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1). It jointly encodes the question and passage using a separate local ONNX model. Batches of four and two inference threads by default bound CPU use.
5. Evidence admission checks relevance thresholds, ambiguous model/error codes, policy versions and explicit numerical measurements with requested units. It returns `supported`, `clarify`, `insufficient` or `conflict`.
6. The voice agent grounds its answer in the sources. The no-key text path quotes an English passage. Unsupported questions require clarification or an operator. Source cards are visible directly in Demo.

`retrieve` is the interface for customer-facing evidence decisions. The compatibility `search(query, limit)` method returns unthresholded candidates for legacy technical scenarios. `POST /api/knowledge/search` with `domain` or `context` returns an evidence object; omitting both retains the old array response.

Cosine, `rerankScore` and RRF scores are not probabilities of answer correctness. `supported` means bounded relevance checks passed, not that every premise of a question is proven. Checks for power, capacity, weight, dimensions and voltage prevent some false matches but do not replace general factual entailment. New industries require additional evaluation cases and threshold calibration.

## Documents and reindexing

Chunks retain Markdown heading ancestry, table-header context and extracted PDF page numbers. The target is up to 180 words with 35-word overlap. This is text extraction, without OCR or reconstruction of complex table layouts. New uploads retain the original extracted text for reindexing.

When upgrading an existing installation, run `db:migrate`, `db:seed`, then `rag:reindex`. See the [reindex procedure](rag-reindex.md). Changing the embedding model without reindexing excludes old vectors from retrieval: equal dimensionality does not make embedding spaces compatible.

For an English-copy update on an installation that already has migration005, rebuild and rerun `db:seed` to refresh scenario templates and built-in documents. Existing session transcripts and uploaded documents are preserved. Start a new session to use the updated English fixture data.

## Reproducible evaluation

`docs/evaluation/repair.json` contains 54 English questions: 44 with expected sources, including four follow-ups; eight unsupported questions; and two requiring model clarification. The original RU/EN set is retained as `docs/evaluation/repair-multilingual.json`; use `RAG_EVAL_DATASET=docs/evaluation/repair-multilingual.json` to run it separately against the English corpus. Versioning, scopes, PDF pages, tables and metadata updates have additional unit/integration coverage.

```sh
# Creates a random schema, indexes the evaluation corpus and removes the schema in finally.
# Does not book calendar events or invoke voice providers.
docker compose -f compose.yaml -f compose.app.yaml run --rm api pnpm rag:evaluate
```

The report defaults to `artifacts/rag-evaluation.json`; override with `RAG_EVAL_REPORT`. The command exits nonzero if any check fails. Metrics include expected source in top3, evidence-status accuracy, unsupported-query rejection and warm retrieval p50/p95 latency. `rawSourceRecallAt3` measures context-free retrieval without reranking for embedding comparisons.

Set `RAG_RERANKER=off` for an ablation. The legacy model can be selected with `RAG_EMBEDDING_MODEL=Xenova/bge-small-en-v1.5`. Each evaluation indexes its own schema, preserving public vectors. Cosine thresholds are not directly comparable between models: compare raw recall or calibrate admission separately. The historical BGE comparison used `RAG_MIN_SEMANTIC_SCORE=0.35` as a diagnostic setting, not a recommended production threshold.

The dataset was used during development. Its results are regression checks, not a held-out benchmark or a promise of equivalent accuracy on client documents. Results and limitations are recorded in [validation](validation.md). Earlier bilingual-corpus ablation reports are historical and should not be compared directly to the current English-only corpus.
