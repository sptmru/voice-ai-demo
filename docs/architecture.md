# Relay — appliance repair voice demo

## Repair and RAG extension (2026-09-16)

The default theme is fictional appliance repair in Yerevan. `repair-runtime.ts` implements the no-key text policy; `repair-tools.ts` owns customer-scoped jobs, service prices and explicit conversation context. The existing booking adapter is reused for workshop/home diagnosis. A booking is not a claim that the appliance has been repaired. Repair outcomes use `repair_support`; only a saved appointment can resolve the booking workflow.

`RagService.retrieve` accepts domain and conversation context, filters current documents, combines RU/EN full text with multilingual E5 cosine search, reranks candidates with a multilingual cross-encoder, and returns evidence states. The compatibility `search` method returns unthresholded candidates for older callers. Repair tools and the scoped knowledge inspector use `retrieve`. Migration005 adds document metadata, original input, heading/page locators and Russian FTS. See [RAG details](rag.md) and [model migration](rag-reindex.md).

## Earlier business demo extension (2026-09-16)

The earlier presentation extension added appointment booking, lead qualification and
fictional order support while retaining the technical workbench and seven telecom
scenarios. `business-tools.ts` supplies scenario-checked tools;
`business-runtime.ts` provides the explicit no-key multi-turn workflow. Voice uses
`buildScenarioPrompt` with the same executor and persistence. That earlier extension preceded the repair/RAG changes above.

`packages/integrations/src/calendar.ts` owns server-side Google OAuth, availability,
time-zone-aware slots and event insertion. Appointment attempts use one stable
calendar booking key per session, persist the pending selection before external
work, and persist the confirmed event reference afterwards. Repeats must match the
original selection. Unconfigured calendars explicitly use demo mode; partial
configuration fails closed. See [calendar setup and limits](calendar.md).

`004_handoff.sql` adds the persisted handoff state. Requesting a human snapshots a
factual brief; accepting changes `waiting` to `accepted`. Owner-checked HTTP routes
provide `/api/operator/queue`, `/api/sessions/:id/handoff`,
`/api/sessions/:id/handoff/accept` and `/api/sessions/:id/operator/messages`.
Customer and operator replies share the persisted transcript, with distinct roles.
AI tools, confirmations and voice reconnection are disabled after transfer. The
executor serializes tools and confirmations per session, and voice shutdown drains
in-flight work before an HTTP handoff is committed. This is a browser demo of the
operator workflow; there are no separate staff identities or telephone transfers.

## Scope and delivery

Local, zero-cost-first demo for fictional CPaaS provider Relay. Implement and verify five runnable increments: (1) text support + PostgreSQL tools + hybrid RAG + live dashboard, (2) Gemini voice, (3) uploads and selective memory, (4) OpenAI voice, (5) scenarios, confirmations, escalation, inspection and deployment guide. Real provider calls require user-supplied keys; do not confuse contract tests with live validation. PSTN is optional and excluded from this delivery.

## Architecture and tradeoffs

- pnpm workspace, TypeScript, Next.js/React UI on :3100; Express HTTP/SSE and WebSocket API on :3101. Next rewrites `/api/*`; voice connects to the API. One application, two development processes, one PostgreSQL/pgvector container. No Redis, SaaS database, or agent framework.
- `packages/core`: domain schemas, observable events, provider-independent tools/executor, workflow and application memory. Explicit application state; no private chain-of-thought is stored or displayed.
- `packages/db`: SQL migration, deterministic fictional operational data, persistence. Customer identity is bound to a server-side session, never accepted from model tool arguments. Scenarios are per-session snapshots so concurrent demos cannot alter each other's accounts.
- `packages/rag`: Markdown/text/PDF parsing, section-aware chunks, local ONNX multilingual E5 (384 dimensions), pgvector cosine + RU/EN Postgres full text, reciprocal-rank fusion and multilingual cross-encoder reranking. Model downloaded once and cached; no fabricated semantic fallback. Embedding model ID stored with chunks.
- `packages/voice`: small realtime contract, Gemini WebSocket and OpenAI transport adapters. SDK/wire formats stay here. Audio, transcripts, tool calls, interruption and provider state normalize at this boundary. Tools return through the same executor used by text.
- `apps/api`: session ownership, HTTP validation, SSE replay, WebSocket bridge, bounded uploads, rate/concurrency limits, structured logs. Local demo identity is explicitly not production authentication.
- `apps/web`: three-column call / observable activity / evidence workbench; responsive, keyboard accessible; knowledge upload, prior sessions, confirmation cards and after-call report.

The no-key text mode is an explicitly labelled deterministic diagnostic policy, not an LLM simulation. It branches on real tool results, reuses the same registry across every scenario, retrieves real chunks, persists tickets and validated outcomes. Realtime models choose their own tools against the same application contracts. Documentation/tool outputs are untrusted evidence, not instructions.

## Domain and contracts

Customer/account includes ID, company, contact, plan, balance and products. Scenario snapshot includes account restrictions, trunk registration/authentication, caller ID, number routing, recent calls and incidents. Session owns customer, scenario, status, diagnosis, transcript, outcome, ticket, pending confirmations and event history. Persist tickets, callbacks, follow-ups, escalations and credential-reset audit records locally; external dispatch is mocked and labelled.

`ToolDefinition`: name, description, Zod input schema, JSON schema, permission (`read-only | write | sensitive-write | human-only`) and `execute(input, context)`. Context fixes session/customer, repository, retrieval and event emitter. Executor validates arguments, enforces permissions and idempotency, records sanitized arguments/results and durations. Sensitive actions are proposed first, confirmed via a session-bound UI action, single-use and expiring. The model cannot grant itself permission.

`AgentEvent`: id, sessionId, correlationId, timestamp, type, payload, optional durationMs. Persist before delivery; SSE supports replay using event IDs. Event types: customer.identified, retrieval.started/completed, tool.started/completed/failed, confirmation.required/resolved, support.state, transcript, voice.state/turn/metric, call.outcome, error. Outcomes have a Zod schema and server-owned ticket/action references.

`RealtimeVoiceSession`: sendAudio, sendText, sendToolResult, interrupt, close, typed event subscription; exposes transport/audio capabilities and optional provider-specific resumption. Browser PCM capture/playback is outside domain logic. Provider-specific rates, cancel/truncate and reconnection semantics remain explicit.

## Original telecom slice acceptance (historical)

1. Migrate and seed real PostgreSQL/pgvector; index fictional telecom docs with local BGE embeddings.
2. Browser starts Acme UK SIP-403 session, sends text and receives persisted live SSE events.
3. Execute customer/account, call, trunk, KB and incident tools; derive carrier diagnosis from evidence, create a real local ticket, persist validated outcome.
4. Test tool validation/customer scope, workflow evidence and ticket persistence, RAG ranking and SSE; typecheck/build and browser desktop/mobile flow.
5. Document startup, exact mocked boundaries, later credential-dependent validation and current milestone evidence.

## Constraints / decisions requiring input

No architectural questions block implementation. User must provide Gemini/OpenAI keys locally for live provider testing. Docker requires sandbox escalation on this host. No production deployment or paid services are required. The presentation, default replies and built-in repair corpus are in English. Multilingual retrieval still accepts Russian questions; legacy telecom scenarios remain available.
