ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{"domain":"general","version":"1","status":"active"}'::jsonb;
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS page integer;
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS heading_path jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS search_vector_ru tsvector GENERATED ALWAYS AS (to_tsvector('russian', search_text)) STORED;
CREATE INDEX IF NOT EXISTS knowledge_chunks_search_ru_idx ON knowledge_chunks USING gin(search_vector_ru);
CREATE INDEX IF NOT EXISTS knowledge_documents_domain_idx ON knowledge_documents ((metadata->>'domain'));

-- Retain original input so changing embedding models never requires lossy chunk reconstruction.
ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS original_content text;
