ALTER TABLE support_sessions ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'rehearsal' CHECK (mode IN ('rehearsal','live'));
CREATE TABLE IF NOT EXISTS appointment_records (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL UNIQUE REFERENCES support_sessions(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS repair_jobs (
  id uuid PRIMARY KEY,
  reference text NOT NULL,
  session_id uuid NOT NULL REFERENCES support_sessions(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, reference)
);
CREATE INDEX IF NOT EXISTS repair_jobs_reference ON repair_jobs(reference);

-- Preserve existing calendar actions without calling any provider. One stable
-- appointment exists per session; its action UUID becomes the persisted ID.
INSERT INTO appointment_records(id,session_id,data,created_at)
SELECT DISTINCT ON(a.session_id) a.id,a.session_id,
  jsonb_build_object('serviceId',a.input->>'serviceId','provider',a.input->>'provider',
    'eventId',a.input->>'eventId','start',a.input->>'start','end',a.input->>'end',
    'htmlLink',a.input->>'htmlLink','status','booked'),a.created_at
FROM support_actions a
WHERE a.kind='appointment' AND a.input->>'provider' IN ('google','demo')
  AND a.input ?& ARRAY['serviceId','eventId','start','end']
ORDER BY a.session_id,a.created_at
ON CONFLICT(session_id) DO NOTHING;
UPDATE support_sessions s SET mode='live'
FROM appointment_records a WHERE a.session_id=s.id AND a.data->>'provider'='google';

INSERT INTO repair_jobs(id,reference,session_id,data,created_at)
SELECT gen_random_uuid(),fixture->>'id',s.id,
  fixture || jsonb_build_object('issue','Demo repair inquiry','history',jsonb_build_array(
    jsonb_build_object('status',fixture->>'status','note',fixture->>'note','at',s.created_at,'actor','system'))),s.created_at
FROM support_sessions s CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.snapshot#>'{repair,jobs}','[]'::jsonb)) fixture
WHERE fixture->>'id' IS NOT NULL
ON CONFLICT(session_id,reference) DO NOTHING;
INSERT INTO repair_jobs(id,reference,session_id,data,created_at)
SELECT gen_random_uuid(),'REP-'||upper(left(a.id::text,8)),a.session_id,
  jsonb_build_object('customerId',s.customer_id,'appliance',COALESCE(s.snapshot#>>'{repair,appliance}','unspecified'),
    'model',COALESCE(s.snapshot#>>'{repair,model}','Not supplied'),'issue',COALESCE(s.snapshot#>>'{repair,issue}','Diagnosis requested'),
    'status','scheduled','note','Diagnosis appointment booked. Repair has not started.','readyAt',NULL,'appointmentId',a.id,
    'history',jsonb_build_array(jsonb_build_object('status','scheduled','note','Existing appointment imported.','at',a.created_at,'actor','system'))),a.created_at
FROM appointment_records a JOIN support_sessions s ON s.id=a.session_id
WHERE s.snapshot ? 'repair'
ON CONFLICT(session_id,reference) DO NOTHING;
