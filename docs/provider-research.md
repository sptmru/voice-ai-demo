# Realtime provider implementation notes

Verified against official documentation on 2026-09-15. This is schema research, not a live provider test. Account model access, latency, audio quality and quota still require credentials and an actual call.

## OpenAI: use the Realtime API requested by the brief

The official docs now cover both Realtime and a separate GPT-Live protocol. Keep `OpenAIRealtimeProvider` on Realtime: `session.created`, `session.update`, `response.*`, and `/v1/realtime/calls`. Do not copy GPT-Live's `/v1/live/sessions`, `session.start`, or delegation messages into this adapter. The working connection-guide URLs now begin `voice-`; older `realtime-webrtc` and `realtime-server-controls` URLs returned 404 during research. [Official WebRTC guide](https://developers.openai.com/api/docs/guides/voice-webrtc)

### Recommended browser transport: WebRTC plus server sideband

1. Browser creates a peer connection, a microphone track and `oai-events` data channel. Keep the microphone track disabled until the application reports provider readiness.
2. Browser submits its SDP offer to an authenticated application endpoint bound to the existing support session.
3. Backend POSTs multipart form fields `sdp` and `session` to `https://api.openai.com/v1/realtime/calls`, using its standard API key. The `session` field is JSON with `type: "realtime"`, configured model, audio options, system instructions and tools.
4. OpenAI returns `201`, an SDP answer body, and `Location` containing the opaque call ID. Save that ID against the support session; never accept a browser-selected upstream call ID. Return the SDP answer to the browser. [Create call reference](https://developers.openai.com/api/reference/typescript/resources/realtime/subresources/calls/methods/create)
5. Backend attaches `wss://api.openai.com/v1/realtime?call_id=<encoded-call-id>` with `Authorization: Bearer <server-key>`. This sideband receives model events and carries tool outputs and session updates. Process tool requests only from this server connection. [Official server-side controls, Realtime section](https://developers.openai.com/api/docs/guides/voice-server-controls)

Application design: wait for media setup and sideband readiness before enabling the microphone or asking for the opening response. Close both media and sideband on end/failure. The browser has media/control access, so a sideband is not itself an authorization boundary; the shared executor remains authoritative for customer scope, validation and approval. Do not forward arbitrary browser JSON into the provider or executor.

### Current GA configuration shape

Construct the following object in the adapter from server-owned settings; `tools` is generated from the domain registry. Remove `$schema` before translating tool schemas. Model is chosen when opening the connection, so omit model changes from subsequent updates. [Realtime client-event reference](https://developers.openai.com/api/reference/resources/realtime/client-events)

```ts
const configuration = {
  type: 'realtime',
  instructions: supportInstructions,
  output_modalities: ['audio'],
  audio: {
    input: {
      transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
      turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true },
    },
    output: { voice: 'marin' },
  },
  tools: registry.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: stripSchemaMetadata(tool.jsonSchema),
  })),
  tool_choice: 'auto',
};
// Initial HTTP session additionally contains the selected model.
// Sideband update:
send({ type: 'session.update', session: configuration });
```

The GA fields are nested `audio.input.*` and `audio.output.*`; avoid beta's top-level audio-format fields. `session.updated` confirms effective settings, but does not echo the client `event_id`. Input transcription is asynchronous and approximate. PCM on an OpenAI WebSocket uses 24 kHz; WebRTC negotiates its media. [Realtime client-event reference](https://developers.openai.com/api/reference/resources/realtime/client-events)

### Tool and transcript events

Use a complete `response.done` event as the simple reliable tool boundary: inspect every `response.output` item whose `type` is `function_call`, read `name`, `call_id`, and parse its JSON-string `arguments`. Require a completed response/item and deduplicate by `call_id` before invoking the shared executor. Return `conversation.item.create` with `item: {type: "function_call_output", call_id, output: JSON.stringify(executionResult)}`. After all outputs from that response are inserted, send one `response.create`. [Realtime conversation lifecycle and function calls](https://developers.openai.com/api/docs/guides/realtime-conversations)

Normalize `conversation.item.input_audio_transcription.completed` and `response.output_audio_transcript.done` into final user/assistant transcript events; deltas are UI updates, not additional final turns. Preserve `item_id` for reconciliation. Use `response.created`/`response.done` for generation lifecycle and `input_audio_buffer.speech_started`/`speech_stopped` for speech activity. OpenAI WebRTC interruption can truncate unplayed audio server-side. Manual interruption uses `response.cancel` and `output_audio_buffer.clear`; the equivalent WebSocket path also needs playback tracking and `conversation.item.truncate`. [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)

### Simpler server relay alternative

Open `wss://api.openai.com/v1/realtime?model=<configured-model>` with a server authorization header. Send/receive audio as JSON base64 frames: input `input_audio_buffer.append.audio`, output `response.output_audio.delta.delta`. This avoids browser provider credentials and a second upstream connection, but requires PCM capture, resampling, buffering, playback and accurate cancellation/truncation in the application. Official guidance prefers WebRTC for browser robustness. [Official WebSocket guide](https://developers.openai.com/api/docs/guides/voice-websockets)

Do not automatically retry a disconnected OpenAI session as if it preserved the conversation. Start a new provider session with a bounded application summary and an explicit reconnect state unless a separately verified resumption contract is implemented.

## Gemini Live: server WebSocket relay

Use the server-side endpoint `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=<server-key>`. Never log this URL. Current official examples select `gemini-3.1-flash-live-preview`; keep `GEMINI_MODEL` configurable rather than assuming an older preview remains available. [Official Gemini WebSocket guide](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket)

Send `setup` first, then wait for `setupComplete`. The reference schema places audio modality inside `setup.generationConfig.responseModalities`; a quickstart snippet flattens it incorrectly, so follow the API reference. Setup cannot be changed on the open connection. [Gemini Live wire reference](https://ai.google.dev/api/live)

```ts
send({
  setup: {
    model: `models/${configuredModel}`,
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } },
    },
    systemInstruction: { parts: [{ text: supportInstructions }] },
    tools: [{ functionDeclarations: translatedDomainTools }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: {},
    contextWindowCompression: { slidingWindow: {} },
  },
});
```

Audio frames use `realtimeInput.audio: {data: base64, mimeType: "audio/pcm;rate=16000"}`. PCM is signed 16-bit little-endian; input is natively 16 kHz and output is 24 kHz. Output bytes arrive under `serverContent.modelTurn.parts[].inlineData`. Text can use `realtimeInput.text`; deliberate complete turns/history use `clientContent.turns` plus `turnComplete`. [Gemini capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities)

`toolCall.functionCalls[]` contains `{id,name,args}`. Execute on the server and reply with `toolResponse.functionResponses[]: [{id,name,response:{result: executionResult}}]`. There is no OpenAI-style `response.create` after a Gemini tool response. [Gemini tool-response example](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket)

Normalize `serverContent.inputTranscription.text`/`outputTranscription.text`, `turnComplete`, and `interrupted`; interruption clears the browser playback queue immediately. `toolCallCancellation.ids` cancels unstarted work; already committed actions cannot be silently undone. Manual `activityStart`/`activityEnd` are valid only when automatic activity detection is disabled. [Gemini wire reference](https://ai.google.dev/api/live)

Resumption: enable `setup.sessionResumption`, retain a `sessionResumptionUpdate.newHandle` only when `resumable` is true, and reconnect with `setup.sessionResumption.handle`. Observe `goAway.timeLeft`. Some states, including tool execution, are not resumable; do not replay writes blindly. Connection lifetime is documented around ten minutes; audio-only sessions without compression have a fifteen-minute limit. [Gemini session management](https://ai.google.dev/gemini-api/docs/live-api/session-management)

## Minimal provider-independent application interface

This is an application design proposal. Provider wire types stay inside `packages/voice`; the domain tools continue using `ToolCall`/`ToolExecutionResult` only.

```ts
interface RealtimeVoiceSession {
  capabilities: {
    transport: 'websocket-pcm' | 'webrtc-sideband';
    inputSampleRate?: number;
    outputSampleRate?: number;
    resumption: boolean;
  };
  sendAudio(frame: { pcm16: Uint8Array; sampleRate: number }): Promise<void>;
  sendText(text: string): Promise<void>;
  sendToolResult(result: ToolExecutionResult): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  on(
    event: 'state' | 'audio' | 'transcript' | 'toolCall' | 'interrupted' | 'turn' | 'metric' | 'error',
    handler: (payload: unknown) => void,
  ): () => void;
}
```

For WebRTC, browser media bypasses `sendAudio`; that method must explicitly reject unsupported use. `connect` can return an additional transport-specific `{sdpAnswer}` outside the domain. Add optional provider-specific resumption metadata without pretending all providers share replay semantics.

Required local adapter tests: setup readiness, malformed/unknown events, fragmented transcript assembly, multiple tool calls in one response, duplicate calls, pending approval results, interruption queue clearing, late canceled results, provider failure cleanup, no-key configuration, and session ownership. Live checks with each actual key must separately prove audible input/output, a real RAG/tool cycle, interruption, and structured outcome persistence.

## M2 implementation status

`packages/voice/src/gemini.ts` implements the raw Gemini relay with the public contract in `types.ts`. Configuration, input/output audio, transcripts, tool calls/results, cancellation, setup timeout and closure are exercised by 11 local mock-socket protocol tests in `tests/voice.test.ts`. No provider access is implied by those tests.

The implementation deliberately advertises `resumption: false`; `goAway` is surfaced so the caller can reconnect explicitly. `interrupt()` clears local playback and suppresses subsequent audio for the interrupted local turn until a provider interruption or turn boundary. It sends no invented Gemini cancellation command. Automatic provider VAD performs real server-side interruption when the user speaks. The first-input-to-first-audio metric is recorded once per connection and includes the time spent supplying the first input; it is not a pure model latency measurement.

## M4 implementation status

`packages/voice/src/openai.ts` implements `OpenAIRealtimeProvider` using server-authenticated multipart call creation, a validated OpenAI `Location` call ID, and a trusted sideband WebSocket. The adapter waits for `session.created`, sends its application-owned configuration, then waits for `session.updated` before reporting readiness. It returns the SDP answer through the common session interface. The browser transports audio using WebRTC; calling this adapter's PCM `sendAudio` rejects explicitly.

Response scheduling is application-owned: VAD has `create_response:false` and `interrupt_response:true`. A committed audio input, text request, or completed tool batch requests generation through one queue. An active response or outstanding tool batch delays the next `response.create`. This is an implementation choice to prevent competing automatic/manual generation requests.

Completed response tool calls are deduplicated and grouped; every tool output retains its `call_id`, and the final result in a batch triggers one continuation. Barge-in discards unstarted/late canceled tools and outputs from interrupted responses. Transcripts reconcile by item ID; no sideband audio or private reasoning events are sent to the UI.

Closing includes an authenticated `POST /v1/realtime/calls/{call_id}/hangup` so the media call ends as well as the sideband. Failed setup after call creation uses the same cleanup. Hangup failures are surfaced separately because closing a control connection does not prove media termination. [OpenAI hangup reference](https://developers.openai.com/api/reference/typescript/resources/realtime/subresources/calls/methods/hangup)

Local mock HTTP/WebSocket tests cover creation, setup acknowledgment, batching, response scheduling, interruption, transcripts, malformed calls, timeouts, cleanup and equivalent tool contracts across Gemini/OpenAI. Live OpenAI audio and account access remain unverified without an OpenAI key.
