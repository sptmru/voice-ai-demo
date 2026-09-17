# Implementation validation

## 2026-09-16 — Workshop cleanup and photos during voice

Removed retired scenarios, domain tools, prompts, built-in documents and the original specification PDF. Current customer context uses workshop services. Migration 007 removes only the old built-in corpus and obsolete fields on supported snapshots; uploaded documents and historical session records remain stored. Retired scenarios are rejected at session creation and excluded from history and source-linked memory retrieval. No public deployment or production migration was performed.

The owner-authenticated `POST /api/sessions/:id/voice/photos` accepts JPEG, PNG and WebP up to 5 MB while voice is connected. Browser uploads are resized to 1600 pixels and converted to JPEG, previewed and sent from either presentation or Live workspace. The application stores a transcript marker rather than image bytes. Text-mode photo review remains available separately.

Verification:

- 131 unit tests and 68 integration tests passed. Integration tests used a dedicated temporary PostgreSQL container with external provider credentials disabled.
- TypeScript checks and the production Next.js build passed.
- 19 distinct Chromium scenarios passed across the affected regression runs, including three final photo flows in desktop/mobile presentation and Live workspace. Desktop/mobile browser tests verify photo preview, retry after an upload error, and a single uninterrupted voice connection without a configured vision provider. UI provider boundaries are stubbed; the integration test separately verifies real HTTP, owner checks, malformed/oversized images, disconnected uploads, and continued audio forwarding.
- Real Gemini Live (`gemini-3.1-flash-live-preview`) read the synthetic label correctly: “Model W100, error code E21.” The image was sent after an initial spoken greeting in the same connection; output included 418592 bytes of PCM audio across both turns. This is a bounded synthetic-label check, not a damaged-label benchmark or real-microphone test. See [voice photo evidence](evaluation/voice-photo-verification.json).
- OpenAI image input is covered by protocol tests; live OpenAI account behavior was not checked.

The first Gemini experiment sent separate realtime video and text messages and received a reply asking for the photo. Those streams have no ordering guarantee. The implementation instead sends image `inlineData` and text in one `clientContent` turn, verified in the live check. Contracts: [Gemini client content and realtime inputs](https://ai.google.dev/api/live), [OpenAI Realtime image inputs](https://developers.openai.com/api/docs/guides/realtime-conversations#image-inputs).

## 2026-09-16 — Complete workshop journey

Implemented generative repair text via configured OpenAI/Gemini, reviewed photo extraction,
immutable Rehearsal/Live session mode, persistent booking and repair records, revision-bound
rescheduling/cancellation and quote confirmation, operator lifecycle changes, readiness and
local RAG warmup. Migration 006 backfills existing appointment actions without external calls.
The public application was not rebuilt or redeployed during this work.

Verification on the working tree:

- 142 unit tests passed, including both provider adapters, text tools, photo output validation,
  calendar PATCH/DELETE and all-day timezone handling, conversation checks and voice proof harness.
- Full integration run: 65 tests passed in disposable schemas. The final additional photo-context
  regression was verified by rerunning all four workshop HTTP tests; 66 distinct integration cases
  are covered across these runs. The ten lifecycle cases were rerun after calendar retry fixes.
- 20 Chromium workflows passed: four new workshop flows plus sixteen existing regressions.
  Desktop/mobile screenshots were inspected. UI photo responses were stubbed in browser tests.
- Root/web TypeScript checks and production Next.js build passed.
- Real retrieval plus deterministic conversation evaluation: 11 conversations, 38/38 turns,
  329/329 bounded assertions. This is regression evidence, not a held-out production benchmark.
- Actual Gemini text (`gemini-2.5-flash`): two conversations, five turns, twelve model requests.
  47/47 assertions passed after a documented checker correction accepting offered slot end times.
  Initial real runs caught UTC-as-local display and unpersisted withdrawal of booking intent;
  the application now returns local slot labels and persists explicit withdrawal before generation.
- Actual Gemini vision read W100 and E21 correctly from one synthetic legible appliance label.
  This does not establish accuracy for real camera photos or damaged labels.
- Actual Gemini native voice (`gemini-3.1-flash-live-preview`): real warranty retrieval, correct
  90-day answer and spoken source citation; 9/9 checks. Received 18 seconds of PCM audio;
  first input to first audio was about 4.38 seconds in this single sample. Input was synthetic
  text, so this does not verify microphone speech recognition or live interruption. Interruption
  and provider failure behavior remain covered by protocol mocks.

No real Google booking, rescheduling, cancellation, email or SMS was performed. Google mutation
contracts were checked against mocked HTTP; OpenAI's new text/vision paths were also checked with
mocked HTTP, not a live account. Tests forcibly clear external credentials except explicitly
bounded model-only verification. Preview services were stopped and their schemas removed.

See [verification snapshot](evaluation/conversation-verification.json),
[conversation evaluator](evaluation/CONVERSATIONS.md) and [workflow/deployment](workshop.md).

This file separates source implementation, local automated tests, and real provider evidence. Repair and customer operational records remain fictional local PostgreSQL data.
