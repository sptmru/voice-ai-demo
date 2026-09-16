import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type { KnowledgeMetadata } from '../packages/core/src/domain.js';

type LegacyChunk = { section: string; content: string };

/** Keep every stored passage, including overlap: guessing deduplication could discard real text. */
export function reconstructLegacyContent(title: string, chunks: LegacyChunk[]): string {
  if (!chunks.length || !chunks.some((chunk) => chunk.content.trim()))
    throw new Error('No original input or nonempty stored chunks; upload the original document again');
  const heading = (text: string) => text.replace(/[\r\n]+/g, ' ').trim();
  const parts = [`# ${heading(title)}`];
  let previousSection = '';
  for (const chunk of chunks) {
    if (chunk.section && chunk.section !== previousSection) {
      parts.push(`## ${heading(chunk.section)}`);
      previousSection = chunk.section;
    }
    parts.push(chunk.content);
  }
  return parts.join('\n\n');
}

export async function reindexKnowledge(database: Pool, options: { dryRun?: boolean; force?: boolean } = {}) {
  const { RagService, EMBEDDING_SIGNATURE } = await import('../packages/rag/src/index.js');
  const rag = new RagService(database);
  const { rows } = await database.query<{
    id: string;
    title: string;
    source: string;
    type: string;
    embedding_model: string;
    original_content: string | null;
    metadata: KnowledgeMetadata;
  }>(
    'SELECT id,title,source,type,embedding_model,original_content,metadata FROM knowledge_documents ORDER BY source,id',
  );
  let indexed = 0;
  let skipped = 0;
  let reconstructed = 0;
  console.log(
    `${options.dryRun ? 'Dry run' : 'Reindex'}: ${rows.length} documents; target ${EMBEDDING_SIGNATURE}`,
  );
  for (const document of rows) {
    if (!options.force && document.embedding_model === EMBEDDING_SIGNATURE) {
      skipped++;
      continue;
    }
    try {
      let content = document.original_content;
      if (!content?.trim()) {
        const chunks = await database.query<LegacyChunk>(
          'SELECT section,content FROM knowledge_chunks WHERE document_id=$1 ORDER BY ordinal,id',
          [document.id],
        );
        content = reconstructLegacyContent(document.title, chunks.rows);
        reconstructed++;
        console.warn(
          `Legacy reconstruction: ${document.source}. Original page layout is unavailable; chunk overlap is retained. Reupload the original for faithful page citations.`,
        );
      }
      if (content.length > 300_000)
        throw new Error('Reconstructed input exceeds 300,000 characters; upload the original document again');
      if (!options.dryRun) {
        const result = await rag.ingest({
          title: document.title,
          source: document.source,
          type: document.type,
          metadata: document.metadata,
          content,
          force: options.force,
        });
        console.log(`Indexed ${document.source}: ${result.chunkCount} chunks`);
      } else {
        console.log(`Would index ${document.source}: ${content.length} characters`);
      }
      indexed++;
    } catch (error) {
      throw new Error(
        `${options.dryRun ? 'Dry run' : 'Reindex'} stopped at ${document.source} after ${indexed} ${options.dryRun ? 'eligible' : 'indexed'} documents (${skipped} already current). Earlier successful documents remain committed; rerun to resume. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  console.log(
    `${options.dryRun ? 'Dry run complete: would index' : 'Reindex complete:'} ${indexed}; skipped ${skipped}; legacy reconstructions ${reconstructed}.`,
  );
  return { indexed, skipped, reconstructed, dryRun: !!options.dryRun };
}

async function main() {
  const args = process.argv.slice(2);
  const allowed = ['--dry-run', '--force', '--help'];
  if (args.some((arg) => !allowed.includes(arg))) throw new Error(`Supported options: ${allowed.join(', ')}`);
  if (args.includes('--help')) {
    console.log(
      'pnpm rag:reindex [--dry-run] [--force]\nRebuild saved knowledge with the configured embedding model. Run db:migrate first.\n--dry-run reads documents without embedding or writing. --force also rebuilds current-model documents.',
    );
    return;
  }
  const [{ default: pg }, { databaseUrl }] = await Promise.all([
    import('pg'),
    import('../packages/db/src/config.js'),
  ]);
  const database = new pg.Pool({ connectionString: databaseUrl(), max: 2, connectionTimeoutMillis: 5000 });
  try {
    await reindexKnowledge(database, { dryRun: args.includes('--dry-run'), force: args.includes('--force') });
  } finally {
    await database.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
