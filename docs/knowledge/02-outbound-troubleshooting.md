# Outbound calling diagnostic procedure

Fictional Relay operations runbook for support engineers, revision 2026-09-15.

## Start with customer and scope

Identify the customer from the authenticated support session. Read the account, plan and enabled products before selecting a trunk. Ask whether all outbound calls fail, only a country prefix fails, or only a caller identity fails. Compare recent failed records against historical successful calls. Read-only diagnostics are safe to perform without an action confirmation.

## Ordered checks for SIP 403

Inspect account restrictions and balance first. Confirm international calling and the UK destination group are enabled. Check registration, authentication and caller-ID verification. Inspect call records for SIP codes, direction, destination and carrier. Search the knowledge base for the observed evidence, then check active incidents for the affected region. Do not reset a healthy trunk just because a carrier returned Forbidden.

## Correlate evidence before diagnosis

A current UK carrier incident combined with valid credentials, permitted destinations, verified caller ID and recent UK SIP 403 failures supports a carrier-degradation diagnosis. A missing policy permission supports an account restriction instead. If multiple causes appear possible, report what is known and the missing evidence. Create a support ticket for unresolved impact, reference the incident when applicable and offer a callback or follow-up. Local demo callbacks and notifications are recorded without external dispatch.
