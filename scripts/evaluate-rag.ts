import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { databaseUrl } from '../packages/db/src/config.js';
import { migrate } from '../packages/db/src/migrate.js';
import { seedRepairKnowledge } from './seed.js';
import { RagService, EMBEDDING_MODEL } from '../packages/rag/src/index.js';
import type { RetrievalRequest, RetrievalStatus } from '../packages/core/src/domain.js';

type Case = Pick<RetrievalRequest, 'query' | 'context'> & {
  id: string;
  expectedStatus: RetrievalStatus;
  expectedSources: string[];
  language: string;
};
const datasetPath = process.env.RAG_EVAL_DATASET
  ? resolve(process.env.RAG_EVAL_DATASET)
  : new URL('../docs/evaluation/repair.json', import.meta.url);
const dataset = JSON.parse(await readFile(datasetPath, 'utf8')) as Case[];
const schema = `relay_eval_${randomUUID().replaceAll('-', '')}`;
const connectionString = process.env.TEST_DATABASE_URL || databaseUrl();
const admin = new pg.Pool({ connectionString });
const database = new pg.Pool({ connectionString, options: `-c search_path=${schema},public` });
const reportPath = resolve(process.env.RAG_EVAL_REPORT || 'artifacts/rag-evaluation.json');
const results = [];
try {
  await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(database);
  await seedRepairKnowledge(database);
  const rag = new RagService(database);
  // Warm both models before measuring; downloads and indexing are excluded from retrieval latency.
  await rag.retrieve({ query: 'Какой срок гарантии на ремонт?', domain: 'repair' });
  for (const item of dataset) {
    const started = performance.now();
    const result = await rag.retrieve({
      query: item.query,
      context: item.context,
      domain: 'repair',
      limit: 3,
    });
    const elapsedMs = Math.round(performance.now() - started);
    // The raw, context-free search is useful for comparing embedding models without
    // transferring admission thresholds between models with different cosine scales.
    const raw = await rag.search(item.query, 3);
    const rawSourceHit =
      !item.expectedSources.length || raw.some((c) => item.expectedSources.includes(c.source));
    const hit =
      !item.expectedSources.length || result.chunks.some((c) => item.expectedSources.includes(c.source));
    const pass = result.status === item.expectedStatus && hit;
    results.push({
      ...item,
      actualStatus: result.status,
      sourceHit: hit,
      rawSourceHit,
      pass,
      elapsedMs,
      reason: result.reason,
      rewrittenQuery: result.rewrittenQuery,
      retrieved: result.chunks.map((c) => ({
        source: c.source,
        section: c.section,
        semanticScore: c.semanticScore,
        rerankScore: c.rerankScore,
      })),
    });
    console.log(
      `${pass ? 'PASS' : 'FAIL'} ${item.id} [${item.language}] ${item.query} => ${result.status}${hit ? '' : ' wrong source'}`,
    );
  }
  const supported = results.filter((r) => r.expectedStatus === 'supported');
  const unsupported = results.filter((r) => r.expectedStatus === 'insufficient');
  const latency = results.map((r) => r.elapsedMs).sort((a, b) => a - b);
  const summary = {
    evaluatedAt: new Date().toISOString(),
    dataset: process.env.RAG_EVAL_DATASET || 'docs/evaluation/repair.json',
    embeddingModel: EMBEDDING_MODEL,
    reranker: process.env.RAG_RERANKER || 'on',
    cases: results.length,
    passed: results.filter((r) => r.pass).length,
    sourceRecallAt3: supported.filter((r) => r.sourceHit).length / supported.length,
    rawSourceRecallAt3: supported.filter((r) => r.rawSourceHit).length / supported.length,
    rawSourceRecallByLanguage: Object.fromEntries(
      ['ru', 'en'].map((language) => {
        const rows = supported.filter((r) => r.language === language);
        return [language, rows.length ? rows.filter((r) => r.rawSourceHit).length / rows.length : null];
      }),
    ),
    admissionOverrides: {
      semantic: process.env.RAG_MIN_SEMANTIC_SCORE ?? null,
      rerank: process.env.RAG_MIN_RERANK_SCORE ?? null,
    },
    statusAccuracy: results.filter((r) => r.actualStatus === r.expectedStatus).length / results.length,
    unsupportedRejected: unsupported.filter((r) => r.actualStatus === 'insufficient').length,
    unsupportedTotal: unsupported.length,
    latencyP50Ms: latency[Math.floor(latency.length * 0.5)],
    latencyP95Ms: latency[Math.floor(latency.length * 0.95)],
    note: 'Curated demo regression set; not a held-out benchmark. Local CPU, warm models; timing excludes indexing/downloads. Isolated database schema removed after evaluation.',
  };
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ summary, cases: results }, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Report: ${reportPath}`);
  if (results.some((r) => !r.pass)) process.exitCode = 1;
} finally {
  await database.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
