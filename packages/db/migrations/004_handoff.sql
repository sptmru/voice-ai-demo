ALTER TABLE support_sessions ADD COLUMN IF NOT EXISTS handoff jsonb;
ALTER TABLE support_sessions ADD CONSTRAINT support_sessions_handoff_status
  CHECK (handoff IS NULL OR handoff->>'status' IN ('waiting', 'accepted'));
