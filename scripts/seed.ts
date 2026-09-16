import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { pool } from '../packages/db/src/index.js';
import { migrate } from '../packages/db/src/migrate.js';
import { demoCustomer, scenarioSnapshot } from '../packages/db/src/fixtures.js';
import { RagService } from '../packages/rag/src/index.js';
import { scenarioIds } from '../packages/core/src/domain.js';

export async function seedOperationalData(database: Pool = pool): Promise<void> {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO customers(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data',
      [demoCustomer.id, JSON.stringify(demoCustomer)],
    );
    for (const id of scenarioIds) {
      await client.query(
        `INSERT INTO scenario_templates(id,customer_id,snapshot) VALUES($1,$2,$3)
        ON CONFLICT(id) DO UPDATE SET customer_id=EXCLUDED.customer_id,snapshot=EXCLUDED.snapshot`,
        [id, demoCustomer.id, JSON.stringify(scenarioSnapshot(id))],
      );
    }
    // Explicitly fictional customer profile memory, separate from transcripts and generated case history.
    await client.query(
      `INSERT INTO customer_memory(id,customer_id,kind,content,source_session_id) VALUES
      ('00000000-0000-4000-8000-000000000101',$1,'fact',$2,NULL),
      ('00000000-0000-4000-8000-000000000102',$1,'preference',$3,NULL)
      ON CONFLICT DO NOTHING`,
      [
        demoCustomer.id,
        `${demoCustomer.company} operates in timezone ${demoCustomer.timezone}.`,
        'Preferred support follow-up channel: email.',
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function seedKnowledge(database: Pool = pool): Promise<void> {
  const rag = new RagService(database);
  const directory = new URL('../docs/knowledge/', import.meta.url);
  for (const file of (await readdir(directory)).filter((name) => name.endsWith('.md')).sort()) {
    const content = await readFile(new URL(file, directory), 'utf8');
    const title = /^#\s+(.+)$/m.exec(content)?.[1] ?? file;
    const document = await rag.ingest({ title, content, source: `docs/knowledge/${file}`, type: 'markdown' });
    console.log(`Indexed ${document.title}: ${document.chunkCount} chunks`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    await migrate();
    await seedOperationalData();
    await seedKnowledge();
    console.log(
      `Seed complete: Acme Ltd, ${scenarioIds.length} isolated scenario templates and telecom knowledge.`,
    );
  })()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
