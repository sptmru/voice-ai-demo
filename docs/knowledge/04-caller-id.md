# Caller ID verification and outbound identity

Fictional Relay policy for Business SIP Trunking customers. Revision 2026-09-15.

## Verified caller ID is required

Outbound caller ID must be a number assigned to the account or an external number verified by the account owner. Send E.164 values including the leading plus sign. A healthy, registered trunk can still receive SIP 403 when its presented caller ID is unverified or mismatched. Compare the trunk's callerIdVerified flag and configured callerId against recent call records rather than assuming all Forbidden responses are authentication failures.

## Correcting a mismatch

Ask the administrator to select an assigned verified number in the PBX or complete the ownership verification process. Changing caller ID is not a credential reset. Support must not invent ownership or mark a number verified based only on a conversation. For Acme's demo account, +442079460100 is its assigned UK number; +442079460999 is an intentionally unverified scenario identity.

## Verification and escalation

After the customer corrects the identity, ask for a new outbound test call and inspect its final SIP response. Caller-ID compliance can vary by destination carrier. If a verified E.164 identity is rejected despite correct permissions, gather call IDs and carrier details for engineering. Do not promise delivery or bypass anti-spoofing controls.
