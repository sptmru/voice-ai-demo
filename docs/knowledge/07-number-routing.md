# Phone number configuration and inbound routing

Fictional Relay DID configuration handbook. Revision 2026-09-15.

## Inbound number routing prerequisites

An inbound number must be assigned to the customer, enabled, and routed to a valid trunk or application. Read the number's enabled flag and route, then inspect the destination trunk. A missing route with inbound 404 failures supports a number-routing diagnosis. Outbound permissions do not repair an inbound number route.

## Missing or disabled destinations

When route is null, explain that calls have no assigned destination and request the intended trunk from the account administrator. When enabled is false, explain that the number is disabled. Never route a customer's number to a destination belonging to another customer. In the Acme number-routing scenario, +442079460100 is enabled but has no route; its intended demonstration trunk is trunk-acme-london.

## Validation after a routing change

This demo diagnoses and records a routing request; it does not provision a real carrier number. After an authorized administrator restores the route, verify trunk reachability and make an inbound test call. Inspect the call record for successful completion before declaring resolution. Escalate persistent 404 or timeout failures with the number, route, call ID and UTC time.
