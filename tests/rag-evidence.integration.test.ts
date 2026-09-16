import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../packages/db/src/migrate.js';
import { RagService } from '../packages/rag/src/index.js';
import type { KnowledgeMetadata } from '../packages/core/src/domain.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('current, scoped and versioned RAG evidence', () => {
  const schema = `rag_evidence_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const database = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  const rag = new RagService(database);
  beforeAll(async () => {
    await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(database);
  });
  afterAll(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  async function document(source: string, metadata: Partial<KnowledgeMetadata> = {}) {
    return rag.ingest({
      title: 'Warranty ZEPHYR-924',
      source,
      type: 'markdown',
      content:
        '# Repair warranty\nThe ZEPHYR-924 repair warranty covers the completed work for 90 days. Гарантия на выполненный ремонт ZEPHYR-924 составляет 90 дней.',
      metadata: { domain: 'repair', status: 'active', version: '1', ...metadata },
    });
  }
  it('filters archived, future, expired and incompatible embedding indexes before ranking', async () => {
    await document('active');
    await document('archived', { status: 'archived' });
    await document('future', { effectiveFrom: '2099-01-01' });
    await document('expired', { effectiveTo: '2000-01-01' });
    const incompatible = await document('legacy-model');
    await database.query(
      "UPDATE knowledge_chunks SET embedding_model='legacy-incompatible' WHERE document_id=$1",
      [incompatible.id],
    );
    const result = await rag.search('ZEPHYR-924 warranty', 10);
    expect(result.map((item) => item.source)).toEqual(['active']);
    expect(result[0].metadata?.version).toBe('1');
  });
  it('updates metadata without leaving obsolete chunks and scopes domain/model before retrieval', async () => {
    await document('active', { status: 'archived' });
    await document('telecom', { domain: 'telecom' });
    await document('different-model', { models: ['Z900'], appliance: 'refrigerator' });
    await document('wanted-model', { models: ['W100'], appliance: 'washing-machine' });
    const result = await rag.retrieve({
      query: 'ZEPHYR-924 warranty',
      domain: 'repair',
      context: { model: 'W100', appliance: 'washing-machine' },
    });
    expect(result.status).toBe('supported');
    expect(result.chunks.map((item) => item.source)).toEqual(['wanted-model']);
  });
  it('returns conflict when two applicable policy versions survive admission', async () => {
    await document('wanted-model', { status: 'archived' });
    await document('different-model', { status: 'archived' });
    await document('policy-v1', { policyKey: 'warranty', version: '1' });
    await document('policy-v2', { policyKey: 'warranty', version: '2' });
    const result = await rag.retrieve({ query: 'ZEPHYR-924 repair warranty', domain: 'repair' });
    expect(result.status).toBe('conflict');
    expect(new Set(result.chunks.map((item) => item.metadata?.version))).toEqual(new Set(['1', '2']));
  });
});
