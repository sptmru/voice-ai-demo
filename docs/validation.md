# Implementation validation

This file separates source implementation, local automated tests, and real provider evidence. All operational customer/carrier systems remain fictional local PostgreSQL data.

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

| Command                          | Result                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `corepack pnpm typecheck`        | Passed                                                                            |
| `corepack pnpm test`             | 50 passed: core, Gemini, OpenAI, parsers                                          |
| `corepack pnpm test:integration` | 36 passed against isolated PostgreSQL schemas and real cached embeddings          |
| `corepack pnpm test:e2e`         | 4 passed: main case/history/report, mobile sensitive confirmation, search, upload |
| `corepack pnpm build`            | Passed, production Next.js output                                                 |

Integration coverage includes both provider adapters running the same support scenario through the real executor, PostgreSQL and retrieval, with upstream provider transports simulated. It also covers owner isolation, atomic confirmations, redaction, upload limits, SSE replay ordering and voice bridge lifecycle. Browser screenshots: `test-results/m1-desktop.png` and `test-results/m1-mobile.png`.

## Production Docker smoke check

The `relay-voice-support:local` image built successfully. `docker run --rm --network none relay-voice-support:local pnpm --version` returned `10.17.1` as the non-root `node` user, confirming no package-manager download is needed at startup. Corepack uses the shared `/pnpm/corepack` cache.

Isolated web/API containers on ports 3110/3111 were then checked through the production Next.js rewrite. The page and health route returned HTTP 200; the actual PostgreSQL/ONNX retrieval workflow created session `c67c0f0d-833a-4652-8bc1-c130046db5d4`, ticket **`TKT-4D644DAF`**, 30 events and a validated unresolved carrier-incident outcome. End session succeeded. The smoke containers used the existing demo database and cached model, then were removed. This validates a local production-image launch; it is not an external deployment or a fresh-model-download check inside the container.

## Boundaries

- No production deployment or external telecom, CRM, email, callback or paging integration was performed.
- Local synthetic-microphone checks cannot prove physical echo cancellation or real-device audio quality.
- Provider mock transports are contract evidence, not successful cloud API calls.
- The regular development stack remains on ports 3100/3101; the temporary production-image check used separate ports.
- The repository began with the task PDF and no git commits; tests run against current working-tree files.
