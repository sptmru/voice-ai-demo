# Client demo walkthroughs

## Business demo: appointment and handoff

1. Open **Demo** and choose **Book an appointment**. Start voice, or use **Start in text** for the deterministic rehearsal. In text mode ask `Show available times`, then `Book option 1` after reading the offered times.
2. Point out the calendar mode. A local demo booking is labelled as such. With Google configured, inspect the confirmed event and open its Google Calendar link. No invitation email is sent. Follow [calendar setup](calendar.md) before claiming a live integration.
3. Show the result card and expand technical details to inspect the real saved tool calls. End the session and reopen it from history to demonstrate persistence.
4. Start **Meet your next customer**. Say `Need: a booking assistant; Budget: 5000 USD; Timeline: next month`. The lead is saved locally. Ask `Book a meeting` to continue into availability and appointment booking.
5. Start **Help with an order**. Ask about `ORD-1042`, then say `Change delivery to 25 King Street, London, SW1A 1AA`. Review the repeated address and reply `Confirm delivery change`. The result remains pending human review; delivery is not claimed to have changed.
6. Use **Talk to a person** or ask the agent for an operator. Open **Operator desk**, review the reason, context and collected data, accept the conversation and reply. Return to the customer view to show the human message. AI voice and tool execution remain stopped.

The operator desk shares this browser's session ownership cookie. Another tab in the same browser can demonstrate the operator/customer views; a separate browser cannot access those sessions. This is not a production multi-user contact center.

## Original three-minute telecom walkthrough

## 0:00 — Introduce the workspace

“This is Relay, a fictional telecom provider. The left column is the conversation. The middle is a record of observable actions. The right is the evidence and support case.”

Choose **UK carrier incident** and **Start session**. With Gemini configured, the session immediately requests microphone access and connects voice. For a fully local rehearsal, leave provider keys unset or disconnect voice and use the suggested text prompt.

## 0:20 — Report the issue

“Hi, our outbound calls to UK numbers started failing this morning with SIP 403. Please investigate and open a support ticket.”

Point to actual account/call/trunk checks in the activity timeline. Expand a tool to show its sanitized arguments, result and measured duration. Expand retrieved knowledge to show section text, chunk ID, cosine score, lexical rank and RRF score. Scores are ranking evidence, not probabilities of correctness.

## 1:10 — Show the outcome

The agent correlates repeated UK failures with healthy account configuration and an active carrier incident. Show the persisted ticket and unresolved status: an explanation does not prove service recovery. End the session, inspect the structured report and export JSON. Reopen it from **Session history**.

## 1:45 — Make RAG tangible

Open **Knowledge base**. Upload a short Markdown document with a unique diagnostic phrase. Search that phrase immediately and expand the matching chunk. The UI uses the same retrieval service as the agent.

Optionally remove that test document with its trash button and confirm deletion; its passages disappear from search. Session-history rows also have a delete action with confirmation.

## 2:10 — Show a guarded action

Start a **Trunk authentication** scenario. Ask “Please reset trunk credentials.” Show the confirmation card before approving the simulated reset. Explain that even the voice model cannot approve its own action and that only a local demo record changes.

## 2:40 — Close with the architecture

“The operational systems are realistic local mocks; storage and retrieval are real. Voice providers are adapters. Tools, permissions, customer memory, outcomes, and this event history belong to the application.”

If using a provider without live validation, label it as an implemented adapter awaiting account testing. Do not claim production availability, free unlimited voice, physical-microphone echo performance, or external ticket/email delivery.
