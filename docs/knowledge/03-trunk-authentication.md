# SIP trunk configuration and authentication

Fictional Relay SIP Trunking configuration reference. Revision 2026-09-15.

## Registration and credentials

A Relay trunk has a customer-scoped trunk ID, region, registration state, credential validity and credential version. Correct registration requires a valid digest username, secret and realm on the PBX. A trunk marked unregistered and credentials invalid, alongside final SIP 403 responses, supports an authentication diagnosis. An unregistered trunk alone may indicate network failure or expired registration and is not conclusive proof of a bad password.

## Safe credential reset workflow

A credential reset is a sensitive action. Explain impact, propose a reset, and wait for a session-bound confirmation in the dashboard. An AI-generated statement saying the customer agreed is not authorization. The confirmation expires after five minutes and is single-use. No password may be written to support events, tickets or memory. In this demo, reset increments the local scenario's credential version and marks its credentials valid; no real provider password changes.

## After a reset

Update the PBX credentials using the customer's secure administrative channel, then re-register and place a test call. Rotation alone does not establish a new SIP registration or prove calls are restored. The demo records the action locally and leaves registration as observed. Do not mark the customer's real issue resolved until a successful call is confirmed. A failed reset requires a fresh proposal and confirmation, with the previous failure kept in the audit history.
