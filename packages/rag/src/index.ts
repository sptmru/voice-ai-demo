import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { KnowledgeDocument, RetrievalService, RetrievedChunk } from '../../core/src/domain.js';
import { embed, EMBEDDING_MODEL } from './embedding.js';
import { chunkDocument } from './parsing.js';
export { chunkDocument, parseDocument } from './parsing.js';
export { embed, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from './embedding.js';

const modelSignature = `${EMBEDDING_MODEL}:q8:cls:384:v1`;
const mapDocument = (row: Record<string, any>): KnowledgeDocument => ({
  id: row.id,
  title: row.title,
  source: row.source,
  type: row.type,
  chunkCount: row.chunk_count,
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
});

export class RagService implements RetrievalService {
  constructor(private readonly database: Pool) {}

  async listDocuments(): Promise<KnowledgeDocument[]> {
    const { rows } = await this.database.query(
      'SELECT * FROM knowledge_documents ORDER BY created_at DESC, title',
    );
    return rows.map(mapDocument);
  }

  async deleteDocument(id: string): Promise<boolean> {
    // The foreign key removes every chunk and its embedding in this statement.
    const result = await this.database.query('DELETE FROM knowledge_documents WHERE id=$1', [id]);
    return Boolean(result.rowCount);
  }

  async ingest(input: {
    title: string;
    content: string;
    source: string;
    type: string;
  }): Promise<KnowledgeDocument> {
    if (!input.content.trim() || input.content.length > 300_000)
      throw new Error('Document must contain 1–300,000 characters');
    if (!input.title.trim() || !input.source.trim())
      throw new Error('Document title and source are required');
    const hash = createHash('sha256')
      .update(JSON.stringify([input.title, input.content, input.type, modelSignature]))
      .digest('hex');
    const existing = await this.database.query(
      'SELECT * FROM knowledge_documents WHERE source=$1 AND content_hash=$2',
      [input.source, hash],
    );
    if (existing.rows[0]) return mapDocument(existing.rows[0]);
    const chunks = chunkDocument(input.content, input.title);
    if (!chunks.length) throw new Error('Document contains no indexable content');
    if (chunks.length > 500) throw new Error('Document exceeds the 500-chunk limit');
    // Embeddings happen before the transaction, so a failed model download never leaves a partial document.
    const embedded: { section: string; content: string; embedding: number[] }[] = [];
    for (const chunk of chunks)
      embedded.push({
        ...chunk,
        embedding: await embed(`${input.title}\n${chunk.section}\n${chunk.content}`),
      });
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`relay-ingest:${input.source}`]);
      const saved = await client.query(
        `INSERT INTO knowledge_documents(id,title,source,type,content_hash,embedding_model,chunk_count)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source) DO UPDATE SET title=EXCLUDED.title,type=EXCLUDED.type,
        content_hash=EXCLUDED.content_hash,embedding_model=EXCLUDED.embedding_model,chunk_count=EXCLUDED.chunk_count RETURNING *`,
        [randomUUID(), input.title, input.source, input.type, hash, modelSignature, chunks.length],
      );
      const document = saved.rows[0];
      await client.query('DELETE FROM knowledge_chunks WHERE document_id=$1', [document.id]);
      for (const [ordinal, chunk] of embedded.entries()) {
        await client.query(
          `INSERT INTO knowledge_chunks(id,document_id,ordinal,section,content,embedding,embedding_model,search_text)
          VALUES($1,$2,$3,$4,$5,$6::vector,$7,$8)`,
          [
            randomUUID(),
            document.id,
            ordinal,
            chunk.section,
            chunk.content,
            JSON.stringify(chunk.embedding),
            modelSignature,
            `${input.title}\n${chunk.section}\n${chunk.content}`,
          ],
        );
      }
      await client.query('COMMIT');
      return mapDocument(document);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async search(query: string, limit = 5): Promise<RetrievedChunk[]> {
    if (!query.trim() || query.length > 2000) throw new Error('Search query must contain 1–2000 characters');
    const count = Math.min(10, Math.max(1, Math.floor(limit)));
    const vector = await embed(query, true);
    // RRF combines independent rankings, so cosine scores and FTS ranks need no arbitrary rescaling.
    const { rows } = await this.database.query(
      `WITH
      semantic AS (
        SELECT id, 1-(embedding <=> $1::vector) AS score,
          row_number() OVER (ORDER BY embedding <=> $1::vector, id) AS rank
        FROM knowledge_chunks WHERE embedding_model=$4 ORDER BY embedding <=> $1::vector,id LIMIT 40
      ),
      lexical AS (
        SELECT id,ts_rank_cd(search_vector,websearch_to_tsquery('english',$2)) AS score,
          row_number() OVER (ORDER BY ts_rank_cd(search_vector,websearch_to_tsquery('english',$2)) DESC,id) AS rank
        FROM knowledge_chunks WHERE search_vector @@ websearch_to_tsquery('english',$2) AND embedding_model=$4
        ORDER BY score DESC,id LIMIT 40
      ),
      fused AS (
        SELECT COALESCE(s.id,l.id) AS id, COALESCE(s.score,0) AS semantic_score,
          COALESCE(l.score,0) AS lexical_score,
          COALESCE(1.0/(60+s.rank),0)+COALESCE(1.0/(60+l.rank),0) AS combined_score
        FROM semantic s FULL OUTER JOIN lexical l ON s.id=l.id
      )
      SELECT c.id,c.document_id,c.section,c.content,d.title,d.source,d.type,
        1-(c.embedding <=> $1::vector) AS semantic_score,
        ts_rank_cd(c.search_vector,websearch_to_tsquery('english',$2)) AS lexical_score,f.combined_score
      FROM fused f JOIN knowledge_chunks c ON c.id=f.id JOIN knowledge_documents d ON d.id=c.document_id
      ORDER BY f.combined_score DESC,f.semantic_score DESC,c.id LIMIT $3`,
      [JSON.stringify(vector), query, count, modelSignature],
    );
    return rows.map((row) => ({
      chunkId: row.id,
      documentId: row.document_id,
      document: row.title,
      section: row.section,
      content: row.content,
      source: row.source,
      type: row.type,
      semanticScore: Number(row.semantic_score),
      lexicalScore: Number(row.lexical_score),
      combinedScore: Number(row.combined_score),
    }));
  }
}
