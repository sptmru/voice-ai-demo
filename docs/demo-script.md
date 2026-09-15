# A three-minute portfolio walkthrough

## 0:00 — Introduce the workspace

“This is Relay, a fictional telecom provider. The left column is the conversation. The middle is a record of observable actions. The right is the evidence and support case.”

Choose **UK carrier incident** and **Start session**. For a fully local rehearsal, use the suggested text prompt. For a live demonstration, configure Gemini first and click **Connect voice**.

## 0:20 — Report the issue

“Hi, our outbound calls to UK numbers started failing this morning with SIP 403. Please investigate and open a support ticket.”

Point to actual account/call/trunk checks in the activity timeline. Expand a tool to show its sanitized arguments, result and measured duration. Expand retrieved knowledge to show section text, chunk ID, cosine score, lexical rank and RRF score. Scores are ranking evidence, not probabilities of correctness.

## 1:10 — Show the outcome

The agent correlates repeated UK failures with healthy account configuration and an active carrier incident. Show the persisted ticket and unresolved status: an explanation does not prove service recovery. End the session, inspect the structured report and export JSON. Reopen it from **Session history**.

## 1:45 — Make RAG tangible

Open **Knowledge base**. Upload a short Markdown document with a unique diagnostic phrase. Search that phrase immediately and expand the matching chunk. The UI uses the same retrieval service as the agent.

## 2:10 — Show a guarded action

Start a **Trunk authentication** scenario. Ask “Please reset trunk credentials.” Show the confirmation card before approving the simulated reset. Explain that even the voice model cannot approve its own action and that only a local demo record changes.

## 2:40 — Close with the architecture

“The operational systems are realistic local mocks; storage and retrieval are real. Voice providers are adapters. Tools, permissions, customer memory, outcomes, and this event history belong to the application.”

If using a provider without live validation, label it as an implemented adapter awaiting account testing. Do not claim production availability, free unlimited voice, physical-microphone echo performance, or external ticket/email delivery.
