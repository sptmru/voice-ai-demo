# Client demo walkthroughs

## Main demo: appliance repair

1. Open **Appliance troubleshooting → Start in text**. Send `My Relay Wash W100 washing machine will not drain and shows E21. What should I do?`. Open a source to show the instruction and its version. A symptom is not a confirmed pump failure.
2. Ask `What is the repair warranty?`. Show the current 90-day policy and the retained appliance context. The archived 30-day warranty is excluded from retrieval.
3. Ask `How much does diagnosis cost?`. Prices come from the service catalog: workshop diagnosis is 5000 AMD, credited toward an approved repair; a home visit is 8000 AMD, without a repair credit. Then ask `Book a workshop appointment`, review the times and say `Choose option 1`.
4. Show the booking result and calendar mode. With no credentials this is a local demo booking; with Google configured it creates a real event. Use empty calendar credentials for rehearsals that should not create real events. No invitation email is sent.
5. In **Check repair status**, ask `Check REP-1042`: the quote is awaiting approval and no completion date is confirmed. These are fictional records, not an integration with a workshop ERP.
6. Show the limits: `What does error E21 mean?` in a new session requires a model; `What is the compressor power of Relay Cool C100 in watts?` has no supporting specification. Ask for an operator and show the transferred context.

To demonstrate knowledge updates, upload a short English Markdown document to the `repair` domain with a unique fact and version metadata. Search finds it immediately. When replacing a policy, remove or archive the prior version; overlapping active versions with the same `policyKey` prevent a definitive answer. Seed restores built-in documents and preserves user uploads. All Relay appliance models are fictional; these documents are not real manufacturer manuals.

The interface, scenario suggestions and default replies are in English. Russian questions remain part of the multilingual retrieval evaluation.

## Additional legacy scenarios

## Business demo: appointment and handoff

1. Open **Demo** and choose **Book an appointment**. Start voice, or use **Start in text** for the deterministic rehearsal. In text mode ask `Show available times`, then `Book option 1` after reading the offered times.
2. Point out the calendar mode. A local demo booking is labelled as such. With Google configured, inspect the confirmed event and open its Google Calendar link. No invitation email is sent. Follow [calendar setup](calendar.md) before claiming a live integration.
3. Show the result card and expand technical details to inspect the real saved tool calls. End the session and reopen it from history to demonstrate persistence.
4. Start **Meet your next customer**. Say `Need: a booking assistant; Budget: 5000 USD; Timeline: next month`. The lead is saved locally. Ask `Book a meeting` to continue into availability and appointment booking.
5. Start **Help with an order**. Ask about `ORD-1042`, then say `Change delivery to 25 King Street, London, SW1A 1AA`. Review the repeated address and reply `Confirm delivery change`. The result remains pending human review; delivery is not claimed to have changed.
6. Use **Talk to a person** or ask the agent for an operator. Open **Operator desk**, review the reason, context and collected data, accept the conversation and reply. Return to the customer view to show the human message. AI voice and tool execution remain stopped.

The operator desk shares this browser's session ownership cookie. Another tab in the same browser can demonstrate the operator/customer views; a separate browser cannot access those sessions. This is not a production multi-user contact center.

## Share a photo during voice

Start a workshop voice session. Open **Add a label or error-code photo**, choose a PNG, JPEG or WebP (up to 5 MB), check the preview and click **Send photo to voice agent**. Keep talking: the agent receives the image in the current call. Ask it to read the visible model or error code, then correct uncertain characters verbally. Image bytes are not persisted; after reconnecting, send the photo again if needed.
