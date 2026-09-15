# Voice providers

## Configuration

Set keys in the local `.env` and restart the API after changes. Never send keys to the browser.

```dotenv
VOICE_PROVIDER=gemini
GEMINI_API_KEY=your-key
GEMINI_MODEL=gemini-3.1-flash-live-preview

# Optional second provider:
OPENAI_API_KEY=your-key
OPENAI_REALTIME_MODEL=gpt-realtime
```

`VOICE_PROVIDER` determines the dashboard default. The selector permits either configured provider for a new connection. Switching requires disconnecting the existing voice connection; the support session, customer, tools, retrieval and event history remain the same.

The text diagnostic policy uses no model API. Gemini requires model access and available quota; free-tier availability is account-dependent, not a guarantee of unlimited free voice. OpenAI requires its own API account/billing. No external model is required for embeddings.

The browser's voice WebSocket uses the page's hostname and port by default; Next.js forwards it to the API. A single forwarded host port, selected by `.env` `PORT` (default 3100), carries HTTP, SSE and voice. Container ports remain web 3100 and API 3101. For HTTPS set `WEB_ORIGIN` to the exact public origin and `COOKIE_SECURE=true`; leave `VOICE_PUBLIC_URL` unset unless overriding the voice proxy origin. See [Tunnel setup](deployment.md#cloudflare-tunnel).

## Transport differences

| Capability       | Gemini Live                                                                                            | OpenAI Realtime                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Browser media    | AudioWorklet → signed mono PCM16 at 16 kHz → application WebSocket                                     | Browser microphone → WebRTC to OpenAI                                                                  |
| Server transport | Authenticated Gemini bidirectional WebSocket                                                           | Authenticated call creation + trusted sideband WebSocket                                               |
| Output           | 24 kHz PCM queued in browser AudioContext                                                              | Negotiated WebRTC audio track                                                                          |
| Tool format      | `toolCall.functionCalls` / `toolResponse.functionResponses`                                            | Completed function calls from `response.done`; `function_call_output`; one response per finished batch |
| Turn control     | Automatic provider VAD                                                                                 | Server VAD; application serializes response creation                                                   |
| Interrupt        | Provider speech-start interrupt clears playback; manual playback stop suppresses remaining turn output | Cancel response and clear provider output buffer; WebRTC truncation handled by provider                |
| Transcripts      | Fragments accumulated until turn complete/interruption                                                 | Input/output transcript deltas plus final events with item IDs                                         |
| Reconnect        | New connection with bounded app context                                                                | New WebRTC call with bounded app context                                                               |
| Long-term memory | Shared application memory                                                                              | Shared application memory                                                                              |

The common interface is intentionally small. OpenAI `sendAudio` rejects PCM input because media uses WebRTC. SDP is an explicit OpenAI transport extension; it never enters tools or database domain objects. Gemini's provider-side automatic resumption is not enabled: reconnect is explicit and does not replay uncertain mutations. The application limits a browser voice connection to 15 minutes.

## Workflow and guardrails

The model decides which tools to request. The application validates every call, fixes customer scope, executes it, persists an event and sends back the actual result. Browser messages cannot impersonate tool calls. Sensitive reset approval is an expiring, single-use UI operation. The outcome is runtime-validated, and ticket/action references are derived from server records.

After a conversational turn, a provider-independent completeness check detects an investigation that omitted retrieval or structured finalization. At most two explicit workflow reminders are sent to the model. Ending an incomplete session still records a factual, unresolved partial outcome with a human-review next step; it never invents recovery or a confirmed cause. Events show these state transitions.

## Live checks

The following commands use real Gemini quota. Use a configured key intentionally:

```sh
pnpm live:gemini
# Produces a short spoken test fixture once, through Gemini:
pnpm live:fixture
# With the application running, Chromium installed, and the fixture present:
pnpm live:browser
```

Proof artifacts are ignored by git in `.cache/live-proofs/`. `live:gemini` checks text input → real native-audio response, actual tools, ticket and outcome. `live:browser` feeds a spoken WAV through Chromium's synthetic microphone device, AudioWorklet and the application bridge. This proves the software audio path; physical microphone acoustics, speaker echo and subjective voice quality need a human listening test.

Unit and integration tests inject provider wire responses and verify both adapters without API charges. Those tests do not prove OpenAI account/model availability or live audio behavior. See [validation](validation.md) for exact implementation-session results.

## Failure handling

- Missing credentials disable the connect button and return a clear server error if called directly.
- Setup has bounded timeouts; failed connections stop microphone tracks, playback and sockets.
- Voice failure keeps the support session and persisted events; reconnect or continue in local text mode after disconnecting.
- Slow transport/backpressure is bounded; audio frames are never silently replayed after reconnect.
- Tool IDs are scoped to the support session, fingerprinted and persisted. Duplicate or canceled calls cannot repeat committed actions silently.
- OpenAI close also requests provider-side media hangup. If it cannot confirm hangup, the UI receives an error and the browser closes its media connection.
- Metrics describe their measurement boundary. `first_input_to_first_audio` includes any speaking time and is not a post-speech latency measurement. WebRTC media timing and physical playback are not fabricated from sideband timestamps.

## Official references

Implementation is based on [Gemini Live WebSockets](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket), [Gemini wire schema](https://ai.google.dev/api/live), [OpenAI browser WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc), [OpenAI server-side controls](https://developers.openai.com/api/docs/guides/voice-server-controls), and [Realtime conversation events](https://developers.openai.com/api/docs/guides/realtime-conversations). Detailed verified schema notes are in [provider research](provider-research.md).
