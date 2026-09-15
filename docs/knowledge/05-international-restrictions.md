# International calling and destination permissions

Fictional Relay account policy guide. Revision 2026-09-15.

## Two permissions must allow UK outbound calls

Relay evaluates internationalEnabled and the UK destination group ukEnabled independently for this demo. Both must be true for UK outbound calls. An account on Business does not automatically have international calling enabled. A disabled account permission can produce SIP 403 even when the trunk is registered, credentials are valid and caller ID is verified.

## Diagnose policy restrictions

Inspect the customer-bound account snapshot. If internationalEnabled is false, state that international calling is disabled. If ukEnabled is false, identify the UK destination restriction specifically. Compare recent calls and avoid attributing the issue to a carrier incident when the account already blocks the destination. Do not suggest a credential reset for a destination policy failure.

## Changing permissions

Destination permissions require an authorized account administrator and any applicable fraud review. The support demo does not silently enable destinations. Create a support ticket with the requested destination group and explain the administrative next step. No real account permission changes are sent to a carrier. Once permissions are updated, a successful new call is needed to establish resolution.
