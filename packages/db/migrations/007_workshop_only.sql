-- Remove only the retired built-in corpus; preserve uploaded documents and historical sessions.
DELETE FROM knowledge_documents WHERE source IN (
  'docs/knowledge/01-sip-response-codes.md',
  'docs/knowledge/02-outbound-troubleshooting.md',
  'docs/knowledge/03-trunk-authentication.md',
  'docs/knowledge/04-caller-id.md',
  'docs/knowledge/05-international-restrictions.md',
  'docs/knowledge/06-uk-calling.md',
  'docs/knowledge/07-number-routing.md',
  'docs/knowledge/08-service-plans.md',
  'docs/knowledge/09-incident-handling.md',
  'docs/knowledge/10-escalation.md'
);
-- Existing workshop/business snapshots no longer expose obsolete operational fields.
UPDATE scenario_templates SET snapshot = (snapshot - 'trunk' - 'calls' - 'number' - 'incidents')
  #- '{account,internationalEnabled}' #- '{account,ukEnabled}'
WHERE id IN ('repair-advice','repair-booking','repair-status','appointment-booking','lead-qualification','order-support');
UPDATE support_sessions SET snapshot = (snapshot - 'trunk' - 'calls' - 'number' - 'incidents')
  #- '{account,internationalEnabled}' #- '{account,ukEnabled}'
WHERE scenario_id IN ('repair-advice','repair-booking','repair-status','appointment-booking','lead-qualification','order-support');
UPDATE customers SET data = data || '{"company":"Workshop customer","email":"alex@workshop.example","timezone":"Asia/Yerevan"}'::jsonb
WHERE id='cust-acme' AND data->>'company'='Acme Ltd';
UPDATE customer_memory SET content='Workshop customer operates in timezone Asia/Yerevan.'
WHERE id='00000000-0000-4000-8000-000000000101' AND source_session_id IS NULL
  AND kind='fact' AND content='Acme Ltd operates in timezone Europe/London.';
