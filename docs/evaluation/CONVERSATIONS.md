# English conversation evaluation

`conversations.en.json` exercises eleven conversations and 38 turns, separately from the 54 retrieval questions in `repair.json`. The scenarios were newly written for the conversation improvements. Once a run informs changes, these scenarios become regression coverage; they are not permanently held-out evidence or a customer-production benchmark.

The runner evaluates actual returned answers, retrieved source excerpts, operational tool events, session context, confirmation cards and saved actions. It covers policy follow-ups, model corrections, unknown specifications, customer-bound job lookup, booking consent, changes of mind, a slot taken after it was offered, safety handoff, quote approval, cancellation approval and rescheduling approval.

## Deterministic, no external model calls

```sh
corepack pnpm eval:conversations
```

This uses the real local embeddings, cross-encoder, PostgreSQL repository and deterministic text fallback. It does **not** evaluate generated LLM answers, microphone capture or speech recognition. Models may download on the first run. The runner creates and drops a unique database schema, disables Google credentials for its process and uses the in-memory demo calendar. It never calls the configured real Google calendar.

The existing Compose setup can provide the database network and model cache:

```sh
docker compose -f compose.yaml -f compose.app.yaml run --rm --no-deps --user 0 \
  -e LOG_LEVEL=fatal -v "$PWD:/app" api pnpm exec tsx scripts/evaluate-conversations.ts
```

Results, full answer text, evidence and action records are written to `artifacts/conversation-evaluation-deterministic.json`. Any failed assertion produces a nonzero exit status.

## Optional generated-answer evaluation

This path sends **billable model requests**. It is never enabled merely because API keys exist.

```sh
EVAL_ALLOW_LIVE=1 TEXT_PROVIDER=openai corepack pnpm eval:conversations --live-text
# Or TEXT_PROVIDER=gemini with that provider's key configured locally.
```

Both `EVAL_ALLOW_LIVE=1` and `--live-text` are required. The runner uses the same `createTextAgent()` configuration as the app and records the actual provider/model in `artifacts/conversation-evaluation-live-text.json`. Operational actions remain local rehearsal data and Google Calendar remains disabled. This is generated **text** evaluation, not end-to-end voice evaluation. Keep fictional customer input in these fixtures.

Set `CONVERSATION_EVAL_CASE` to a case ID or comma-separated case IDs for a focused diagnostic run, `CONVERSATION_EVAL_DATASET` for another dataset and `CONVERSATION_EVAL_REPORT` for a different artifact path. Set `CONVERSATION_EVAL_MAX_MODEL_REQUESTS` to cap billable requests (default 40, maximum 100); the runner stops sending requests when the budget is exhausted. Reports record the actual request count. Reports from a filtered run say how many conversations were evaluated; they must not be reported as a complete-suite result.

## What the assertions establish

- Expected citations must appear in both admitted retrieval results and the actual answer.
- Expected factual claims and prohibited promises are checked on the answer text.
- Numerical claims are compared with recorded sources, operational values and tool-derived local appointment labels.
- Clock times in an availability response must match offered slots in the calendar timezone, which catches UTC timestamps incorrectly read as local times.
- Model corrections must appear in persisted context.
- A booking requires an explicitly authorized choice in the scenario and an actually offered slot.
- Sensitive quote/cancellation requests must remain pending until the scenario exercises the application's approval card.
- A competing local reservation makes the previously offered slot unavailable; failure must not create a booking.

These are bounded rule-based checks, not a semantic judge proving every sentence true. A number appearing somewhere in the evidence does not prove that every use of it is correct. English wording can vary in generated answers. Inspect the exact transcript, cited excerpt, state and failed check before deciding whether a failure is an application bug or an assertion that needs a justified correction. Never relabel a deterministic run as live LLM quality evidence.

## Contextual indexing and warmup

Indexing already embeds document title, the complete heading path and chunk content, rather than content alone. Model-specific documents carry model metadata; retrieval filters use it. Adding the model name repeatedly to unrelated policy text is not enabled: evaluation already exposed that excessive model context can hide a subsequent warranty question. Contextual retrieval and current-question reranking are evaluated separately.

`RagService.warmup()` initializes local embedding inference and the cross-encoder without touching the database or external calendars. It reports the embedding signature, reranker mode and initialization duration. The API can finish this before declaring knowledge search ready. Warmup verifies model initialization; it does not prove the knowledge index has been migrated and reindexed.

## Optional real native-audio proof

`scripts/live-repair.ts` opens one bounded Gemini Live connection, supplies a synthetic English text question about repair warranty, executes real local knowledge tools and records the actual native-audio output and final transcript. It creates and removes a disposable schema and exposes no booking or external-write tools.

```sh
EVAL_ALLOW_LIVE=1 corepack pnpm exec tsx --env-file-if-exists=.env scripts/live-repair.ts --live
```

The script requires both opt-ins, uses `GEMINI_API_KEY` / `GEMINI_MODEL`, allows at most eight tool calls and stops waiting for provider output after 60 seconds. Google credentials are disabled in its process. Outputs are `artifacts/repair-voice-proof.json` and a playable mono 24 kHz PCM16 `.wav` alongside it. The report checks actual audio, transcript, knowledge-tool use, active warranty evidence, the 90-day term and spoken source attribution.

This demonstrates **text → native audio**, not microphone capture, recognition of a human accent, acoustic playback quality or real-user interruption. `tests/voice.test.ts` tests adapter interruption, dropped stale audio and provider errors; `tests/voice-proof.test.ts` tests harness tool sequencing, interruption recording, provider failures, call/time limits and connection closure with mocks. A mock interruption result must never be reported as a successful live microphone or barge-in test.
