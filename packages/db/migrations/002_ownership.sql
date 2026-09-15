CREATE TABLE IF NOT EXISTS api_session_owners (
  session_id text PRIMARY KEY,
  owner_hash text NOT NULL
);
CREATE INDEX IF NOT EXISTS api_session_owner_hash ON api_session_owners(owner_hash);
