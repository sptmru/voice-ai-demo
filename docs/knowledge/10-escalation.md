# Technical escalation and support handoff

Fictional Relay engineering escalation runbook. Revision 2026-09-15.

## When to escalate

Escalate unresolved failures when account, credentials, caller ID, routing and incident checks do not establish a cause. A SIP 503 with healthy visible checks and no matching incident is an unknown technical fault, not proof of a carrier outage. Escalate widespread service impact, security-sensitive requests, or cases requiring access beyond the support agent's permitted tools.

## A useful engineering handoff

Create a ticket before handoff and include the issue, affected product, severity, customer impact, call IDs, UTC timestamps, SIP codes, direction, relevant trunk/number IDs, checks performed, knowledge references and unresolved questions. Distinguish facts from hypotheses. Human-only operations include arbitrary configuration changes, billing adjustments, policy overrides and access to secrets. Do not include passwords, API keys or unnecessary personal data.

## Customer-facing outcome and memory

Tell the customer what was checked, what remains unknown, the local ticket reference and the next action. Mark the issue unresolved until there is positive restoration evidence. Store a concise case or conversation summary and relevant customer preference separately from the transcript. Future sessions should retrieve a small selection of relevant prior facts and cases, not every historical message. External engineering dispatch is mocked in the demo and must be labelled as recorded locally.
