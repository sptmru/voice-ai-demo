# SIP response codes: evidence-led troubleshooting

Fictional Relay support handbook. Revision 2026-09-15. Applies to Relay SIP Trunking. Documentation describes possible causes; account tools and current incident records establish the actual case.

## SIP 403 Forbidden: distinguish policy from authentication

A SIP 403 means a request was understood but rejected. It is not proof of invalid credentials. Check account status and balance, international and UK destination permissions, trunk authentication, verified caller ID and active carrier incidents. Compare failed calls by destination, carrier and start time. Historical successes followed by UK-only failures with a healthy trunk increase suspicion of carrier rejection, but still require incident evidence.

## SIP 401 and 407 authentication challenges

A first 401 Unauthorized or 407 Proxy Authentication Required is normally a digest challenge, not a service failure. A client should retry with the correct authorization. Repeated challenges or a final 403 plus invalid credential state justify checking realm, username and password. Never request or expose the customer's SIP secret in chat, transcript or ticket.

## SIP 404, 408 and 503

For inbound 404 Not Found, inspect number assignment and destination route. For 408 Request Timeout, check reachability and registration. SIP 503 Service Unavailable can reflect capacity, maintenance or an upstream failure; it does not by itself establish an active incident. When all visible checks are healthy and the cause remains unknown, collect call IDs, UTC times and destination examples, create a ticket and escalate with uncertainty stated.
