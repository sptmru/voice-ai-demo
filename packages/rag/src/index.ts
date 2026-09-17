import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  KnowledgeDocument,
  KnowledgeMetadata,
  RetrievalService,
  RetrievalRequest,
  RetrievalResult,
  RetrievedChunk,
} from '../../core/src/domain.js';
import { embed, EMBEDDING_SIGNATURE } from './embedding.js';
import { chunkDocument, type TextChunk } from './parsing.js';
import {
  assessEvidence,
  canonicalKnowledgeModel,
  normalizeMetadata,
  resolveRetrievalQuery,
  resolveRerankingQuery,
} from './evidence.js';
import { rerank, warmReranker, RERANKER_ENABLED } from './reranking.js';
export { chunkDocument, parseDocument } from './parsing.js';
export { embed, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, EMBEDDING_SIGNATURE } from './embedding.js';
export { RERANKER_MODEL, RERANKER_ENABLED } from './reranking.js';
export {
  assessEvidence,
  canonicalKnowledgeModel,
  normalizeMetadata,
  resolveRetrievalQuery,
  resolveRerankingQuery,
  isEffective,
} from './evidence.js';

const mapDocument = (row: Record<string, any>): KnowledgeDocument => ({
  id: row.id,
  title: row.title,
  source: row.source,
  type: row.type,
  chunkCount: row.chunk_count,
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  metadata: normalizeMetadata(row.metadata),
});
export class RagService implements RetrievalService {
  constructor(private readonly database: Pool) {}
  async warmup(): Promise<{ embeddingSignature: string; reranker: 'on' | 'off'; elapsedMs: number }> {
    const started = performance.now();
    await Promise.all([embed('appliance repair diagnosis', true), warmReranker()]);
    return {
      embeddingSignature: EMBEDDING_SIGNATURE,
      reranker: RERANKER_ENABLED ? 'on' : 'off',
      elapsedMs: Math.round(performance.now() - started),
    };
  }
  async listDocuments(): Promise<KnowledgeDocument[]> {
    const { rows } = await this.database.query(
      "SELECT * FROM knowledge_documents WHERE metadata->>'domain' IN ('repair','general') ORDER BY created_at DESC, title",
    );
    return rows.map(mapDocument);
  }
  async deleteDocument(id: string): Promise<boolean> {
    return Boolean((await this.database.query('DELETE FROM knowledge_documents WHERE id=$1', [id])).rowCount);
  }
  async ingest(input: {
    title: string;
    content: string;
    source: string;
    type: string;
    metadata?: Partial<KnowledgeMetadata>;
    force?: boolean;
  }): Promise<KnowledgeDocument> {
    if (!input.content.trim() || input.content.length > 300_000)
      throw new Error('Document must contain 1–300,000 characters');
    if (!input.title.trim() || !input.source.trim())
      throw new Error('Document title and source are required');
    const metadata = normalizeMetadata(input.metadata);
    const hash = createHash('sha256')
      .update(
        JSON.stringify([
          input.title,
          input.content,
          input.type,
          metadata,
          EMBEDDING_SIGNATURE,
          'structured-chunks-v2',
        ]),
      )
      .digest('hex');
    const existing = await this.database.query(
      'SELECT * FROM knowledge_documents WHERE source=$1 AND content_hash=$2',
      [input.source, hash],
    );
    if (existing.rows[0] && !input.force) return mapDocument(existing.rows[0]);
    const chunks = chunkDocument(input.content, input.title);
    if (!chunks.length) throw new Error('Document contains no indexable content');
    if (chunks.length > 500) throw new Error('Document exceeds the 500-chunk limit');
    const embedded: (TextChunk & { embedding: number[] })[] = [];
    for (const chunk of chunks)
      embedded.push({
        ...chunk,
        embedding: await embed(`${input.title}\n${chunk.headingPath.join(' > ')}\n${chunk.content}`),
      });
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`relay-ingest:${input.source}`]);
      const saved = await client.query(
        `INSERT INTO knowledge_documents(id,title,source,type,content_hash,embedding_model,chunk_count,metadata,original_content)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT(source) DO UPDATE SET title=EXCLUDED.title,type=EXCLUDED.type,
        content_hash=EXCLUDED.content_hash,embedding_model=EXCLUDED.embedding_model,chunk_count=EXCLUDED.chunk_count,metadata=EXCLUDED.metadata,original_content=EXCLUDED.original_content RETURNING *`,
        [
          randomUUID(),
          input.title,
          input.source,
          input.type,
          hash,
          EMBEDDING_SIGNATURE,
          chunks.length,
          JSON.stringify(metadata),
          input.content,
        ],
      );
      const document = saved.rows[0];
      await client.query('DELETE FROM knowledge_chunks WHERE document_id=$1', [document.id]);
      for (const [ordinal, chunk] of embedded.entries()) {
        await client.query(
          `INSERT INTO knowledge_chunks(id,document_id,ordinal,section,content,embedding,embedding_model,search_text,page,heading_path)
          VALUES($1,$2,$3,$4,$5,$6::vector,$7,$8,$9,$10::jsonb)`,
          [
            randomUUID(),
            document.id,
            ordinal,
            chunk.section,
            chunk.content,
            JSON.stringify(chunk.embedding),
            EMBEDDING_SIGNATURE,
            `${input.title}\n${chunk.headingPath.join(' > ')}\n${chunk.content}`,
            chunk.page ?? null,
            JSON.stringify(chunk.headingPath),
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
  private async candidates(
    query: string,
    request: RetrievalRequest,
    count: number,
  ): Promise<RetrievedChunk[]> {
    if (!query.trim() || query.length > 2000) throw new Error('Search query must contain 1–2000 characters');
    const asOf = request.asOf ?? new Date().toISOString().slice(0, 10);
    normalizeMetadata({ effectiveFrom: asOf }); // Validate date before casting in SQL.
    const vector = await embed(query, true);
    const { rows } = await this.database.query(
      `WITH eligible AS (
      SELECT c.* FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id
      WHERE c.embedding_model=$4 AND d.metadata->>'status'='active' AND d.metadata->>'domain' IN ('repair','general')
        AND ($5::text IS NULL OR d.metadata->>'domain'=$5 OR d.metadata->>'domain'='general')
        AND (d.metadata->>'effectiveFrom' IS NULL OR d.metadata->>'effectiveFrom'<=$6)
        AND (d.metadata->>'effectiveTo' IS NULL OR d.metadata->>'effectiveTo'>=$6)
        AND ($7::text IS NULL OR d.metadata->>'appliance' IS NULL OR lower(d.metadata->>'appliance')=lower($7))
        AND ($8::text IS NULL OR d.metadata->'models' IS NULL OR d.metadata->'models'='[]'::jsonb
          OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(d.metadata->'models') model WHERE lower(model)=lower($8)))
      ), queries AS (SELECT websearch_to_tsquery('english',$2) en,websearch_to_tsquery('russian',$2) ru),
      semantic AS (
        SELECT id,1-(embedding <=> $1::vector) score,row_number() OVER (ORDER BY embedding <=> $1::vector,id) rank
        FROM eligible ORDER BY embedding <=> $1::vector,id LIMIT 40
      ), lexical_scores AS (
        SELECT id, greatest(ts_rank_cd(search_vector,q.en),ts_rank_cd(search_vector_ru,q.ru)) score
        FROM eligible CROSS JOIN queries q WHERE search_vector @@ q.en OR search_vector_ru @@ q.ru
      ), lexical AS (
        SELECT id,score,row_number() OVER (ORDER BY score DESC,id) rank FROM lexical_scores ORDER BY score DESC,id LIMIT 40
      ), fused AS (
        SELECT COALESCE(s.id,l.id) id,COALESCE(s.score,0) semantic_score,COALESCE(l.score,0) lexical_score,
          COALESCE(1.0/(60+s.rank),0)+COALESCE(1.0/(60+l.rank),0) combined_score
        FROM semantic s FULL OUTER JOIN lexical l ON s.id=l.id
      ) SELECT c.id,c.document_id,c.section,c.content,c.page,c.heading_path,d.title,d.source,d.type,d.metadata,
        1-(c.embedding <=> $1::vector) semantic_score,f.lexical_score,f.combined_score
      FROM fused f JOIN knowledge_chunks c ON c.id=f.id JOIN knowledge_documents d ON d.id=c.document_id
      ORDER BY f.combined_score DESC,f.semantic_score DESC,c.id LIMIT $3`,
      [
        JSON.stringify(vector),
        query,
        count,
        EMBEDDING_SIGNATURE,
        request.domain ?? null,
        asOf,
        request.context?.appliance ?? null,
        canonicalKnowledgeModel(request.context?.model) ?? null,
      ],
    );
    return rows.map((row) => ({
      chunkId: row.id,
      documentId: row.document_id,
      document: row.title,
      section: row.section,
      content: row.content,
      source: row.source,
      type: row.type,
      metadata: normalizeMetadata(row.metadata),
      page: row.page ?? undefined,
      headingPath: row.heading_path,
      semanticScore: Number(row.semantic_score),
      lexicalScore: Number(row.lexical_score),
      combinedScore: Number(row.combined_score),
    }));
  }
  /** Compatibility search is unthresholded. Use retrieve for customer-facing evidence decisions. */
  async search(query: string, limit = 5): Promise<RetrievedChunk[]> {
    return this.candidates(query, { query }, Math.min(10, Math.max(1, Math.floor(limit))));
  }
  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    if (!request.query.trim() || request.query.length > 2000)
      throw new Error('Search query must contain 1–2000 characters');
    const started = performance.now();
    const resolved = resolveRetrievalQuery(request);
    if (resolved.ambiguous)
      return {
        status: 'clarify',
        query: request.query,
        rewrittenQuery: resolved.query,
        chunks: [],
        reason:
          'The follow-up has no established appliance or previous question. Ask which appliance or model the customer means.',
      };
    const intentQuery = resolveRerankingQuery(request);
    const contextual = await this.candidates(resolved.query, request, 12);
    // A known model can dominate semantic retrieval of a short new policy question.
    // Merge six intent candidates before contextual candidates; reranking stays bounded to 12.
    const intent = intentQuery !== resolved.query ? await this.candidates(intentQuery, request, 6) : [];
    const candidates = [
      ...new Map([...intent, ...contextual].map((chunk) => [chunk.chunkId, chunk])).values(),
    ].slice(0, 12);
    const retrieved = performance.now();
    const ranked = await rerank(intentQuery, candidates);
    const reranked = performance.now();
    const result = assessEvidence(
      request.query,
      resolved.query,
      ranked,
      Math.min(10, Math.max(1, Math.floor(request.limit ?? 5))),
    );
    return {
      ...result,
      timings: {
        retrievalMs: Math.round(retrieved - started),
        rerankMs: Math.round(reranked - retrieved),
        totalMs: Math.round(performance.now() - started),
      },
    };
  }
}
