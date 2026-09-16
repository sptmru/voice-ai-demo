# Implementation validation

This file separates source implementation, local automated tests, and real provider evidence. Repair, customer and carrier operational records remain fictional local PostgreSQL data.

## English presentation restored — 2026-09-16

At the user's request, the UI, scenario prompts, deterministic replies, default voice
instructions, service/job fixtures and built-in repair documents are now in English.
The brand is **Relay Workshop**. Russian input recognizers and multilingual embeddings
remain available; they no longer make the presentation Russian-first. Earlier transcripts
and session snapshots are preserved. Rebuild and run `db:seed`, then start a new session
to use the translated fixture data and documents. No public deployment was performed.

Verification for this correction:

- **115 unit tests passed**, including exact English guided repair/booking prompts.
- **15 targeted voice-bridge integration tests passed** with blank external provider keys.
- **13 affected browser scenarios passed**: repair, business and support/upload flows.
- Root/web type checking and the production build passed. Desktop/mobile screenshots
  show English headings, prompts, replies, source cards and results.
- The English translation of the 54-question regression set passed **54/54** against the
  English corpus, with expected-source recall44/44, unsupported rejection8/8 and clarification2/2.
  Report: [English demo evaluation](evaluation/english-default.json).

The original bilingual query set is preserved as `evaluation/repair-multilingual.json`,
selectable using `RAG_EVAL_DATASET`. Against the English-only corpus it passes **51/54**:
Russian home-visit coverage and repair-reference format questions return insufficient;
the Russian appointment-change question retrieves the wrong source. These are three known cross-language regressions compared with the former bilingual corpus. Report: [cross-language evaluation](evaluation/english-corpus-multilingual.json).
All eight unsupported cases still decline and both model-less error-code cases clarify.
The English and multilingual evaluations ran concurrently, so their latency is not a
controlled comparison with the earlier measurements below. Earlier corpus/ablation
reports are retained as historical evidence.

## Appliance repair and RAG — 2026-09-16

Implemented the three repair scenarios, model/symptom context, customer-owned job lookup,
structured diagnosis prices, Google/demo diagnostic appointments, source evidence UI and
versioned bilingual knowledge. All changes below are local working-tree changes on base
`d22c90f6bd96638a3bc7bb9699d4ea962c0a7c8c`; the public deployment was not updated.

| Check                                                  | Result                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `corepack pnpm test`                                   | **113 passed**                                                                            |
| `pnpm test:integration` in a one-off Compose container | **52 passed**, disposable PostgreSQL schemas                                              |
| `corepack pnpm test:e2e` against isolated preview      | **16 passed** in one final full run                                                       |
| `corepack pnpm build`                                  | Root/web TypeScript and production Next build passed                                      |
| `pnpm rag:evaluate` with real local ONNX models        | **54/54 passed**, 44/44 expected sources in top3, 8/8 unsupported rejected, 2/2 clarified |

RAG covers active/date/domain/model filtering, ambiguous policy versions, query context,
actual bilingual embeddings and cross-encoder inference, heading/table/PDF page extraction,
metadata updates and legacy reindex reconstruction. Voice bridge fixtures verify repair
context, explicitly selected booking, factual outcomes and serialization of both supported
and insufficient evidence. They are protocol tests, not live model reasoning validation.
Browser checks include a real W100 → warranty follow-up with a 90-day answer and warranty
source, booking, status, desktop/mobile layout and legacy flows. Screenshots:
`test-results/repair-evidence-desktop.png`, `test-results/repair-status-mobile.png`.

Earlier rapid browser batches hit the real 180-request/minute API limit. The final runner
uses one worker and 200ms action pacing (`E2E_SLOW_MO_MS` overrides it); the production
limit remains unchanged. The final full 16-test run passed in 1.2 minutes.

### Retrieval measurements

The 54-question dataset is a curated development/regression set, not held-out evaluation.
The expected-source subset has 23 RU and 21 EN questions. Final warmed local CPU latency
with E5 + reranker: **p50 365ms, p95 475ms**. Download/indexing time is excluded; these are
local measurements, not a production latency promise.

| Configuration                                             | Full cases passed | Expected source in top3 after admission | Unsupported rejected | Warm p50 / p95 |
| --------------------------------------------------------- | ----------------- | --------------------------------------- | -------------------- | -------------- |
| E5 + reranker (default)                                   | 54/54             | 44/44                                   | 8/8                  | 365 / 475ms    |
| E5, reranker off                                          | 50/54             | 43/44                                   | 5/8                  | 13 / 29ms      |
| Legacy BGE, reranker off, diagnostic cosine threshold .35 | 47/54             | 43/44                                   | 2/8                  | 17 / 43ms      |

The BGE admission threshold is deliberately reported and is **not** directly comparable
to E5 thresholds. The fairer context-free, ungated raw source recall is 42/44 for both
embedding models: E5 RU22/23, EN20/21; BGE RU21/23, EN21/21. This small corpus supports
using E5 for the Russian-first demo but does not establish universal superiority.
The stronger result comes from the whole contextual retrieval/reranking pipeline.

Full question-level reports: [default](evaluation/default.json),
[without reranker](evaluation/without-reranker.json), [legacy BGE](evaluation/legacy-bge.json).
Compare using the original [bilingual dataset](evaluation/repair-multilingual.json); reproduction and limitations
are in [RAG documentation](rag.md).

### Calendar test isolation incident

The first integration run inherited newly configured Google credentials from `.env`.
An existing booking fixture unexpectedly created one real calendar event at
2026-09-16 13:15:00 UTC (a 30-minute test consultation for September17). It was identified
by its generated test session/event identifiers and exact timestamp, deleted with no
attendee updates, and its cancellation verified. `vitest.integration.config.ts` now clears
all Google Calendar and voice provider keys after loading `.env`; the voice bridge suite
also asserts demo mode before running. All final tests and the preview used empty external
credentials. This incidental creation is not a comprehensive live calendar acceptance test.
No live voice call or public deployment was performed for the repair extension.

The temporary preview and evaluation/integration schemas are removed after verification.
Existing installations need migration005, seed and uploaded-document reindexing when
this update is deployed; see [reindex procedure](rag-reindex.md). The code changes do not
silently replace the existing public application or its database.

## Earlier business demo extension — 2026-09-16

Implemented appointment booking, lead qualification, order support, Google Calendar
adapter, presentation mode and a persisted browser operator handoff. Existing
telecom scenarios remain. The RAG engine was not changed.

| Check                                                       | Result                                                                |
| ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `corepack pnpm test`                                        | **80 passed**                                                         |
| `pnpm test:integration` in a one-off Compose API container  | **46 passed**, isolated PostgreSQL schemas and cached real embeddings |
| `E2E_BASE_URL=http://127.0.0.1:3100 corepack pnpm test:e2e` | **12 passed** against a separate preview schema                       |
| `corepack pnpm build`                                       | Passed, including root/web type checks and production Next.js build   |

New coverage includes multi-turn business records, missing-field collection,
timezone/afternoon selection, actual Google protocol with mocked HTTP, stable
booking retries and recovery after local persistence failure, order ownership and
confirmation, owner-scoped operator queues, customer/operator text exchange,
voice closure/reconnection rejection after handoff, and a booking workflow through
the real voice bridge with a simulated provider. Gated regressions cover sensitive
confirmation racing handoff and repeated voice shutdown waiting for in-flight work.

Browser checks exercise presentation, technical details, mobile overflow, explicit
text startup with voice configured, handoff closing a browser voice connection,
and the existing support/upload/delete/microphone flows. Screenshots:
`test-results/business-appointment-desktop.png`,
`test-results/business-retail-mobile.png`, `test-results/operator-desktop.png`.
SSE-driven detail refreshes are coalesced to avoid request-limit bursts.

**Historical state at that earlier run:** the four required OAuth/
calendar fields are absent from the local configuration. No external calendar
event or new live model call was made during these checks. See
[Google Calendar setup](calendar.md). The new version has not been deployed to the
running/public demo; its database migration and new scenario seed have only been
applied to isolated test/preview schemas.

## Milestones

1. **Agent + tools + RAG:** implemented. Browser text, real seeded PostgreSQL/pgvector retrieval, actual registry execution, persisted tickets/outcomes and live SSE trace. Desktop/mobile browser flow passed.
2. **Gemini Live:** implemented. Real native-audio API and browser synthetic-microphone scenarios completed with diagnostic tool calls, knowledge retrieval, persisted tickets and outcomes. Workflow checks recover omitted evidence/finalization; a bounded one-minute playback queue accommodates faster-than-realtime generation. Final successful recheck results are recorded below.
3. **Ingestion + memory:** implemented. PDF/Markdown/text upload, real local embeddings, immediate search, seeded facts/preferences, selective prior cases/summaries and end-of-session memory. Upload browser check and real PostgreSQL integration tests passed.
4. **OpenAI Realtime:** implemented with the same tool/runtime contracts and a WebRTC+sideband adapter. Protocol/fixture tests pass. **A real OpenAI call is unverified because no OpenAI key was provided.**
5. **Demo polish:** implemented: responsive workbench, reports/export, scenario reset/history, confirmations, error recovery, escalation/action records, deployment guide and recorded-demo script. Optional PSTN remains outside scope.

## Actual Gemini API evidence

Verified 2026-09-15 using `gemini-3.1-flash-live-preview`:

- Session: `8ce0b5cb-3fc4-412a-9fc8-6ec1c9a1cf2b`.
- Persisted ticket: `TKT-B655906A`.
- Nine actual tool calls, including `search_knowledge_base`, `create_support_ticket` and `complete_support_case`.
- 1,242,750 bytes of real 24 kHz PCM output.
- Setup ready: 365 ms; first submitted **text** to first audio: 3,674 ms; complete run: 29,972 ms. This is one observation, not a latency benchmark or post-speech measurement.
- Validated unresolved outcome identifies the seeded carrier incident and records server-derived action references.
- Local proof: `.cache/live-proofs/gemini-scenario.json` and `.wav` (not committed).

## Actual browser voice evidence

Verified at **2026-09-15T09:16:06.513Z**, with the same real Gemini model:

- Synthetic speech WAV entered through Chromium `getUserMedia` and the application's AudioWorklet. Gemini transcribed the Acme UK SIP-403 request.
- WebSocket frames: 2,405 sent and 207 received; **1,556,222 bytes** of returned audio.
- Persisted ticket: **`TKT-8B3B0DCD`**. The outcome identifies `INC-UK-20260915` and correctly marks the issue unresolved.
- Confirmed customer/account, recent calls, individual call details, trunk, number configuration, incidents, knowledge retrieval and ticket creation in the final action record.
- Manual Stop playback, mute, disconnect and End session exercised; report rendered. No captured browser JavaScript errors.
- Local evidence: `.cache/live-proofs/gemini-browser.json` and `.png`. This proves synthetic microphone transport and manual interruption, not acoustic echo performance or live speech barge-in with physical equipment.

## Automated verification

Final checks on 2026-09-15:

| Command                          | Result                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `corepack pnpm typecheck`        | Passed                                                                                |
| `corepack pnpm test`             | 55 passed: core, providers, browser voice cleanup, parsers and database configuration |
| `corepack pnpm test:integration` | 42 passed against isolated PostgreSQL schemas and real cached embeddings              |
| `corepack pnpm test:e2e`         | 7 passed: support workflows, deletion, automatic voice startup and microphone denial  |
| `corepack pnpm build`            | Passed, production Next.js output                                                     |

Integration coverage includes both provider adapters running the same support scenario through the real executor, PostgreSQL and retrieval, with upstream provider transports simulated. It also covers owner isolation, atomic confirmations, redaction, upload limits, SSE replay ordering and voice bridge lifecycle. Browser screenshots: `test-results/m1-desktop.png` and `test-results/m1-mobile.png`.

## Production Docker smoke check

The `relay-voice-support:local` image built successfully. `docker run --rm --network none relay-voice-support:local pnpm --version` returned `10.17.1` as the non-root `node` user, confirming no package-manager download is needed at startup. Corepack uses the shared `/pnpm/corepack` cache.

Isolated web/API containers on ports 3110/3111 were then checked through the production Next.js rewrite. The page and health route returned HTTP 200; the actual PostgreSQL/ONNX retrieval workflow created session `c67c0f0d-833a-4652-8bc1-c130046db5d4`, ticket **`TKT-4D644DAF`**, 30 events and a validated unresolved carrier-incident outcome. End session succeeded. The smoke containers used the existing demo database and cached model, then were removed. This validates a local production-image launch; it is not an external deployment or a fresh-model-download check inside the container.

## Boundaries

### Deletion and automatic voice follow-up (2026-09-15)

Added confirmed document/session deletion and automatic voice startup on new/reset sessions. Session deletion removes owned session data, local tickets/actions/confirmations and source-linked memory transactionally; database chunks cascade on document deletion. Active tool/voice operations return 409, and deletion races with SSE replay and WebSocket upgrade are covered. Browser start requests microphone permission immediately, connects with the newly returned session ID, and preserves the text session if microphone permission fails. Closing startup cancels its pending promise and repeated close calls await the same shutdown.

Verified with **55 unit tests, 42 integration tests and 7 Chromium tests**, plus type checking and production build. Integration/browser deletions used the separate `relay-feature-review` Compose project and synthetic fixtures, never existing user sessions or documents. Voice browser tests exercised actual browser microphone setup/AudioWorklet against an intercepted test WebSocket; no billed provider connection or public data-bearing browser test was used. Tests cover document cancellation/deletion/search cleanup, session cancellation/409/retry/current-view cleanup, auto-connect/reset with correct session IDs, microphone denial/text fallback, startup cancellation and late microphone cleanup. Dialog screenshots: `test-results/delete-document.png`, `test-results/delete-session-mobile.png`.

The final image was applied to `relay-voice-demo` on port 3477. Local and public `/api/health` checks returned 200; the temporary review stack and its fixture volumes were removed. No user records were deleted during deployment, and no database migration or seed rerun was needed.

### Configurable application port follow-up (2026-09-15)

Compose now maps `127.0.0.1:${PORT:-3100}` to web container port 3100. API retains internal port 3101 with no host publication; PostgreSQL remains private. Applied the user's existing `PORT=3477` by recreating API/web without a rebuild. Local HTTP session creation/end, SSE and authenticated WebSocket upgrades passed on 3477. Both local `/api/health` and `https://voice-ai-demo.sptm.online/api/health` returned 200, replacing the earlier public 502 observation. A proposed public browser regression test was rejected by automatic approval review because it would create records and upload a test document; it was not executed. Public health success is not a full public voice/browser verification.

### Private database follow-up (2026-09-15)

The running stack now uses the API and web Docker containers. PostgreSQL has `HostConfig.PortBindings={}` and is attached only to `relay-voice-demo_database` (`internal=true`); its only peer is the API. The existing `relay-voice-demo_relay_pg` volume was preserved. Host port 55432 is no longer listening. The existing role password differed from the current `.env`; it was synchronized to `POSTGRES_PASSWORD` without printing the secret or replacing data.

The rebuilt image passed type checking and production build. All 36 integration tests passed inside the API container over the private network. A local HTTP scenario created ticket `TKT-E873A77E`, 30 events and a persisted outcome; the health route returned 200 with 11 documents. HTTP/SSE/authenticated WebSocket checks passed with the configured public Origin header. Browser tests against localhost were blocked by the user's HTTPS-only `WEB_ORIGIN=https://voice-ai-demo.sptm.online`; no allowed-origin settings were broadened. A separate public-host probe returned Cloudflare 502, so public ingress is not claimed as verified by this change.

Configuration follow-up on 2026-09-15: database credentials now come from shared `.env` fields; Compose interpolation was checked without printing secrets. Type checking, all 53 unit tests and all 36 integration tests passed. A fresh production web build passed outside the sandbox after its sandboxed validation worker exited without a diagnostic. HTTP session creation, authenticated voice WebSocket upgrade, live SSE delivery and session end were verified through a single web port in both dev (3100) and production (temporary 3110). No provider call or external Cloudflare tunnel was opened for these transport checks. The 4 browser scenario results above are from the initial implementation run.

- No production deployment or external telecom, CRM, email, callback or paging integration was performed.
- Local synthetic-microphone checks cannot prove physical echo cancellation or real-device audio quality.
- Provider mock transports are contract evidence, not successful cloud API calls.
- The current containerized app publishes only the configured host port (3477 at the latest check); API and database are internal. Earlier checks used 3100/3101.
- The repository began with the task PDF and no git commits; tests run against current working-tree files.
