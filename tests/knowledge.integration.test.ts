import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../apps/api/src/app.js';
import { attachKnowledgeUpload } from '../apps/api/src/knowledge.js';
import { PostgresRepository } from '../packages/db/src/index.js';
import { migrate } from '../packages/db/src/migrate.js';
import { RagService } from '../packages/rag/src/index.js';
import { seedOperationalData } from '../scripts/seed.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('knowledge upload HTTP integration with real parsing and embeddings', () => {
  const schema = `relay_knowledge_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const database = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  const repo = new PostgresRepository(database);
  const rag = new RagService(database);
  let server: Server;
  let base: string;

  beforeAll(async () => {
    await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(database);
    await seedOperationalData(database);
  });
  beforeEach(async () => {
    const services = createApp(repo, rag, database);
    attachKnowledgeUpload(services.app, rag);
    services.app.use(services.errorHandler);
    server = await new Promise<Server>((resolve) => {
      const instance = services.app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  afterAll(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  async function upload(
    filename?: string,
    content: string | Buffer = '',
    mime = 'text/plain',
    title?: string,
  ) {
    const form = new FormData();
    if (filename)
      form.set(
        'file',
        new Blob([new Uint8Array(typeof content === 'string' ? Buffer.from(content) : content)], {
          type: mime,
        }),
        filename,
      );
    if (title !== undefined) form.set('title', title);
    const response = await fetch(`${base}/api/knowledge/upload`, { method: 'POST', body: form });
    return { response, body: (await response.json()) as any };
  }
  async function counts() {
    const { rows } = await database.query(
      'SELECT (SELECT count(*) FROM knowledge_documents)::int AS documents,(SELECT count(*) FROM knowledge_chunks)::int AS chunks',
    );
    return rows[0];
  }
  async function search(query: string) {
    const response = await fetch(`${base}/api/knowledge/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as {
      documentId: string;
      content: string;
      section: string;
      source: string;
      type: string;
      semanticScore: number;
      lexicalScore: number;
    }[];
  }

  it('deletes a shared document and every searchable chunk, while retaining other documents', async () => {
    const deleted = await upload(
      'delete-orbit.md',
      '# DELETE-ORBIT-938\nThe DELETE-ORBIT-938 recovery code requires a local reboot.',
      'text/markdown',
    );
    const retained = await upload(
      'retain-orbit.md',
      '# RETAIN-ORBIT-938\nThe retained maintenance document remains searchable.',
      'text/markdown',
    );
    expect(
      (await search('DELETE-ORBIT-938 recovery')).some(
        (chunk) => chunk.documentId === deleted.body.document.id,
      ),
    ).toBe(true);
    const path = `${base}/api/knowledge/${deleted.body.document.id}`;
    expect(
      (await fetch(path, { method: 'DELETE', headers: { Origin: 'https://hostile.example' } })).status,
    ).toBe(403);
    expect((await fetch(`${base}/api/knowledge/not-a-uuid`, { method: 'DELETE' })).status).toBe(400);
    expect((await fetch(`${base}/api/knowledge/${randomUUID()}`, { method: 'DELETE' })).status).toBe(404);
    expect((await fetch(path, { method: 'DELETE' })).status).toBe(204);
    expect(
      (
        await database.query('SELECT id FROM knowledge_chunks WHERE document_id=$1', [
          deleted.body.document.id,
        ])
      ).rowCount,
    ).toBe(0);
    expect((await rag.listDocuments()).some((document) => document.id === deleted.body.document.id)).toBe(
      false,
    );
    expect((await rag.listDocuments()).some((document) => document.id === retained.body.document.id)).toBe(
      true,
    );
    expect(
      (await search('DELETE-ORBIT-938 recovery')).some(
        (chunk) => chunk.documentId === deleted.body.document.id,
      ),
    ).toBe(false);
    expect((await fetch(path, { method: 'DELETE' })).status).toBe(404);
  });

  it('accepts Markdown, indexes it immediately and keeps identical repeated uploads stable', async () => {
    const text =
      '# ORBIT-731 troubleshooting\n## Maintenance window\nORBIT-731 is a fictional Glasgow trunk maintenance event. Support should state that service resumes at 16:35 UTC after verification.';
    const first = await upload('orbit.md', text, 'text/markdown', 'ORBIT-731 maintenance');
    expect(first.response.status).toBe(201);
    expect(first.body.status).toBe('indexed');
    expect(first.body.durationMs).toBeGreaterThanOrEqual(0);
    expect(first.body.document).toMatchObject({ title: 'ORBIT-731 maintenance', type: 'markdown' });
    const beforeRepeat = await counts();
    const repeated = await upload('orbit.md', text, 'text/markdown', 'ORBIT-731 maintenance');
    expect(repeated.response.status).toBe(201);
    expect(repeated.body.document.id).toBe(first.body.document.id);
    expect(await counts()).toEqual(beforeRepeat);
    const result = await search('ORBIT-731');
    expect(result[0].documentId).toBe(first.body.document.id);
    expect(result[0].content).toContain('16:35 UTC');
    expect(result[0].section).toBe('Maintenance window');
    expect(result[0].source).toMatch(/^uploads\/[a-f0-9]{16}\/orbit\.md$/);
    expect(result[0].semanticScore).toBeGreaterThan(0);
    expect(result[0].lexicalScore).toBeGreaterThan(0);
  });

  it('accepts UTF-8 plain text and makes its new fact available through the search API', async () => {
    const result = await upload(
      'bristol.txt',
      'BREEZE-642 support notice: the fictional Bristol trunk restarts at 09:45 UTC. Engineers should verify registration before closing the case.',
      'text/plain',
    );
    expect(result.response.status).toBe(201);
    expect(result.body.document.type).toBe('text');
    const retrieved = await search('BREEZE-642');
    expect(retrieved[0].documentId).toBe(result.body.document.id);
    expect(retrieved[0].content).toContain('09:45 UTC');
  });

  it('extracts and indexes the actual supplied PDF fixture through multipart HTTP', async () => {
    const pdf = await readFile(
      new URL('../docs/voice-ai-support-engineer-codex-prompt.pdf', import.meta.url),
    );
    expect(pdf.length).toBeGreaterThan(100_000);
    const result = await upload(
      'support-task.pdf',
      pdf,
      'application/pdf',
      'Source support engineer specification',
    );
    expect(result.response.status).toBe(201);
    expect(result.body.document.type).toBe('pdf');
    expect(result.body.document.chunkCount).toBeGreaterThan(5);
    const retrieved = await search('zero-cost-first portfolio demo');
    expect(
      retrieved.some(
        (chunk) => chunk.documentId === result.body.document.id && /portfolio/i.test(chunk.content),
      ),
    ).toBe(true);
  });

  it('returns 400 for a missing file and 415 for unsupported extensions without indexing', async () => {
    const before = await counts();
    expect((await upload()).response.status).toBe(400);
    expect(
      (await upload('executable.exe', 'This is not a supported knowledge document format.')).response.status,
    ).toBe(415);
    expect(await counts()).toEqual(before);
  });

  it('returns 422 for invalid PDF signatures, invalid UTF-8 and empty text without partial documents', async () => {
    const before = await counts();
    const invalid = await upload(
      'fake.pdf',
      'This is plain text pretending to be a PDF file.',
      'application/pdf',
    );
    expect(invalid.response.status).toBe(422);
    expect(invalid.body.error).toContain('signature');
    expect((await upload('binary.txt', Buffer.from([255, 254, 253, 0]), 'text/plain')).response.status).toBe(
      422,
    );
    expect((await upload('empty.md', '   \n\n ', 'text/markdown')).response.status).toBe(422);
    expect(await counts()).toEqual(before);
    const valid = await upload(
      'after-invalid.txt',
      'RECOVER-538: A valid knowledge document remains indexable after a failed parser request.',
    );
    expect(valid.response.status).toBe(201);
  });

  it('enforces the 5 MiB file cap and extracted-text cap without partially persisting data', async () => {
    const before = await counts();
    const tooLarge = await upload('too-large.txt', Buffer.alloc(5 * 1024 * 1024 + 1, 'x'));
    expect(tooLarge.response.status).toBe(413);
    const extractedTooLarge = await upload('too-much-text.txt', 'x'.repeat(300_001));
    expect(extractedTooLarge.response.status).toBe(422);
    expect(extractedTooLarge.body.error).toContain('300,000');
    expect(await counts()).toEqual(before);
  });

  it('bounds concurrent indexing and recovers after the active upload completes', async () => {
    const original = rag.ingest.bind(rag);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const indexing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    rag.ingest = async (input) => {
      entered();
      await gate;
      return original(input);
    };
    try {
      const pending = upload(
        'concurrent.txt',
        'CONCURRENCY-612 support notice: only one document can be indexed at a time in this local demo.',
      );
      await indexing;
      const second = await upload(
        'second.txt',
        'SECOND-781 support guide: a different document must wait until the current indexing operation is complete.',
      );
      expect(second.response.status).toBe(429);
      release();
      expect((await pending).response.status).toBe(201);
      expect(
        (
          await upload(
            'second.txt',
            'SECOND-781 support guide: a different document must wait until the current indexing operation is complete.',
          )
        ).response.status,
      ).toBe(201);
    } finally {
      release();
      rag.ingest = original;
    }
  });
});
