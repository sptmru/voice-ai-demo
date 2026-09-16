# Complete workshop demonstration

The interface, default agent language, corpus and sample questions are English. Relay Workshop, appliance models, diagnosis prices and repair jobs are fictional. Application records and, in Live mode, Google Calendar changes are real.

## Rehearse, then present

1. Select **Rehearsal** and open **Check demo readiness**. It warms local retrieval, checks the database and shows which AI providers/calendar settings exist. Configuration checks do not prove cloud credentials work. Use **Check microphone** to test browser permission and capture.
2. Start **Appliance troubleshooting** in text or voice. Try “My Relay Wash W100 will not drain and shows E21. What should I do?” Ask a warranty follow-up or correct the model.
3. Upload a clear PNG, JPEG or WebP of a model label/error display (maximum 5 MB). Read the uncertainty notes, correct any mistaken characters, and explicitly apply the fields. Extracted text is untrusted and cannot book or approve anything. The application stores reviewed text and extraction results, not image bytes. Configured vision inference is external in both modes.
4. Ask for a workshop diagnosis and choose an offered time. A local appointment and a new `REP-...` request are saved. Change your mind before selecting a time, or request another time after booking. Reschedule/cancel cards leave the original booking intact until confirmed.
5. Request an operator. In **Operator desk**, accept the conversation, move the request from scheduled to diagnosing, then prepare a quote and move it to awaiting approval. The AI remains paused. The customer reviews and confirms the bound amount; only this customer action permits in-progress repair. The operator may then mark it ready and completed. History survives reload and is visible to sessions owned by the same browser.
6. Select **Live** for a new session when you intentionally want Google Calendar writes. Confirm that Google credentials are configured first. Rehearsal never writes to Google even when those credentials exist.

New repair jobs retain the known appliance, model, issue and appointment reference. Missing information stays missing; model output never establishes parts availability or completion dates. A diagnosis appointment is not proof that an appliance has been repaired. Operator access remains a browser-owner-scoped demonstration, not a staff authentication system or repair ERP integration.

## Text and vision configuration

`TEXT_PROVIDER=auto` uses `OPENAI_API_KEY`, otherwise `GEMINI_API_KEY`, otherwise local deterministic fallback. Select `openai`, `gemini` or `deterministic` explicitly to control it. `VISION_PROVIDER=auto` follows the same key preference; `off` disables photo inference.

Default models are `gpt-4.1-mini` for OpenAI and `gemini-2.5-flash` for Gemini. Override `OPENAI_TEXT_MODEL`, `GEMINI_TEXT_MODEL`, `OPENAI_VISION_MODEL` or `GEMINI_VISION_MODEL` with a compatible model available to your account. Realtime voice retains the existing separate provider/model settings. No keys are sent to the browser or added to URLs.

Text requests retain recent dialogue and the current repair context, use a restricted tool set, execute tools sequentially, and stop on handoff. The loop is bounded to eight provider responses and sixteen tool requests with a 90-second provider deadline. Failed model output does not undo completed operations or automatically retry business writes. The UI tells the user to review saved records before retrying.

OpenAI uses the [Responses function-calling contract](https://developers.openai.com/api/docs/guides/function-calling) with `store:false` and [image input](https://developers.openai.com/api/docs/guides/images-vision). Gemini uses `generateContent` with [function calling](https://ai.google.dev/gemini-api/docs/function-calling) and [image understanding](https://ai.google.dev/gemini-api/docs/image-understanding). Both adapters preserve the model's current-turn tool context; private thinking text is not emitted or persisted by the application.

## State and confirmation boundaries

Migration `006_repair_lifecycle.sql` adds `support_sessions.mode`, `appointment_records` and `repair_jobs`. Appointment and repair updates use revisions and database locks; outdated proposals fail before a card is shown, and confirmation validates again. Existing completed appointment actions are migrated locally without making calendar requests.

The operator cannot approve a customer's quote. Customer quote approval is the only narrowly allowed tool action during handoff; it does not resume the AI. Spoken or typed “yes” never approves a sensitive operation. Handoff, ended sessions, browser ownership and active voice locks are enforced on HTTP routes.

Appointments are currently one per session. After cancellation, start a new session to book again. Deleting a session deletes its local records; it does not delete a Google event. Cancel a live appointment before removing its session. No email/SMS invitations or notifications are sent.

## Deploy the changes

These commands affect the selected installation. Run them from the repository when ready to deploy; local verification does not deploy the application.

```sh
cd /root/dev/personal/voice-ai-demo
docker compose -f compose.yaml -f compose.app.yaml build api
docker compose -f compose.yaml -f compose.app.yaml stop api web
docker compose -f compose.yaml -f compose.app.yaml up -d db
docker compose -f compose.yaml -f compose.app.yaml run --rm --no-deps api pnpm db:migrate
docker compose -f compose.yaml -f compose.app.yaml run --rm --no-deps api pnpm db:seed
docker compose -f compose.yaml -f compose.app.yaml up -d --force-recreate api web
```

This update does not change embedding dimensions or signature. Run `rag:reindex` only if upgrading an older BGE installation or changing the embedding model, following [the reindex procedure](rag-reindex.md). Open a new session to select Rehearsal/Live. Keep both `-f` arguments: `api` and `web` are defined in `compose.app.yaml`.

## Verification

See [conversation quality evaluation](evaluation/CONVERSATIONS.md) for the eleven multi-turn scenarios, reproducible offline checks and explicitly opted-in generated-answer checks. Provider protocol tests and HTTP/browser tests use synthetic data and isolated database schemas. Live text, image and voice checks are bounded samples, not a claim of production accuracy or real-microphone performance.
