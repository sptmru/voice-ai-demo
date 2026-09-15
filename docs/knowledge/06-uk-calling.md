# UK calling guide and carrier rejection checks

Fictional Relay regional guide. Revision 2026-09-15. Demo number examples are fictional.

## Number format and destination group

Use E.164 UK numbers beginning +44. Remove the domestic trunk prefix zero when converting a domestic number. For example a London demonstration destination is +442079460200. Confirm both international calling and the UK destination group are enabled. Verify the caller ID and ensure the SIP trunk is configured for the account's region.

## UK outbound SIP 403 carrier degradation

A registered trunk with valid credentials, verified caller ID, positive balance and enabled international/UK calling can still see upstream SIP 403 rejection. Search for an active UK incident and correlate its start time with recent UK failures and earlier successful calls. In the carrier-incident demonstration, incident INC-UK-20260915 begins at 09:00 UTC on 2026-09-15 and reports Partner A rejecting a subset of UK outbound calls. This is seeded demo incident data, not a live carrier status feed.

## Communicating the incident

Explain that the available evidence points to upstream UK carrier degradation. Create a ticket linked to the incident, record impact and offer updates. Investigating status means engineering has not confirmed restoration or an ETA. Do not promise a fix time, automatically route traffic to an unapproved carrier, or change customer credentials when they are healthy.
