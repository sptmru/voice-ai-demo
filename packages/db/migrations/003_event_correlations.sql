-- Provider tool IDs and confirmation IDs are opaque strings, not necessarily UUIDs.
ALTER TABLE agent_events ALTER COLUMN correlation_id TYPE text USING correlation_id::text;
