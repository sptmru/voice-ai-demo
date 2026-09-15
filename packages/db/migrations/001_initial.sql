CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS customers (
  id text PRIMARY KEY,
  data jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS scenario_templates (
  id text PRIMARY KEY,
  customer_id text NOT NULL REFERENCES customers(id),
  snapshot jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS support_sessions (
  id uuid PRIMARY KEY,
  customer_id text NOT NULL REFERENCES customers(id),
  scenario_id text NOT NULL REFERENCES scenario_templates(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  snapshot jsonb NOT NULL,
  outcome jsonb,
  diagnosis text
);

CREATE TABLE IF NOT EXISTS agent_events (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES support_sessions(id) ON DELETE CASCADE,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL,
  payload jsonb NOT NULL,
  duration_ms integer
);
CREATE INDEX IF NOT EXISTS agent_events_session_id_idx ON agent_events(session_id, id);

CREATE TABLE IF NOT EXISTS support_tickets (
  id text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES support_sessions(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id),
  subject text NOT NULL,
  description text NOT NULL,
  severity text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, subject, description)
);

CREATE TABLE IF NOT EXISTS support_actions (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES support_sessions(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id),
  kind text NOT NULL,
  input jsonb NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'recorded_locally',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS pending_confirmations (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES support_sessions(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  input jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '5 minutes',
  created_at timestamptz NOT NULL DEFAULT now(),
  result jsonb
);
CREATE INDEX IF NOT EXISTS pending_confirmations_session_idx ON pending_confirmations(session_id);

CREATE TABLE IF NOT EXISTS customer_memory (
  id uuid PRIMARY KEY,
  customer_id text NOT NULL REFERENCES customers(id),
  kind text NOT NULL CHECK (kind IN ('fact', 'preference', 'summary', 'case')),
  content text NOT NULL,
  source_session_id uuid REFERENCES support_sessions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  UNIQUE(customer_id, kind, content)
);
CREATE INDEX IF NOT EXISTS customer_memory_search_idx ON customer_memory USING gin(search_vector);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  source text NOT NULL UNIQUE,
  type text NOT NULL,
  content_hash text NOT NULL,
  embedding_model text NOT NULL,
  chunk_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  section text NOT NULL,
  content text NOT NULL,
  embedding vector(384) NOT NULL,
  embedding_model text NOT NULL,
  search_text text NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', search_text)) STORED,
  UNIQUE(document_id, ordinal)
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_search_idx ON knowledge_chunks USING gin(search_vector);
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx ON knowledge_chunks USING hnsw(embedding vector_cosine_ops);
