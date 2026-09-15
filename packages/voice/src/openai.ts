import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { ToolExecutionResult } from '../../core/src/executor.js';
import type {
  ProviderSocket,
  RealtimeVoiceProvider,
  RealtimeVoiceSession,
  SocketFactory,
  VoiceEvent,
  VoiceSessionConfig,
} from './types.js';

const API = 'https://api.openai.com';
const isRecord = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export interface OpenAIProviderOptions {
  apiKey: string;
  model?: string;
  socketFactory?: SocketFactory;
  fetcher?: typeof fetch;
  setupTimeoutMs?: number;
  hangupTimeoutMs?: number;
}
export function openAISchema(schema: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !['$schema', '$id', 'definitions', '$defs'].includes(key))
      .map(([key, value]) => [
        key,
        Array.isArray(value)
          ? value.map((v) => (isRecord(v) ? openAISchema(v) : v))
          : isRecord(value)
            ? openAISchema(value)
            : value,
      ]),
  );
}
/** Never use an arbitrary Location URL as an authenticated request target. */
export function openAICallId(location: string | null): string {
  if (!location) throw new Error('OpenAI did not return a call identifier');
  let url: URL;
  try {
    url = new URL(location, API);
  } catch {
    throw new Error('Invalid OpenAI call location');
  }
  const match = /^\/v1\/realtime\/calls\/([a-zA-Z0-9_-]{1,200})$/.exec(url.pathname);
  if (url.origin !== API || url.username || url.password || url.search || url.hash || !match)
    throw new Error('Invalid OpenAI call location');
  return match[1];
}
function configuration(config: VoiceSessionConfig) {
  return {
    type: 'realtime',
    instructions: config.instructions,
    output_modalities: ['audio'],
    audio: {
      input: {
        transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
        turn_detection: { type: 'server_vad', create_response: false, interrupt_response: true },
      },
      output: { voice: 'marin' },
    },
    tools: config.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: openAISchema(tool.jsonSchema),
    })),
    tool_choice: 'auto',
  };
}

export class OpenAIRealtimeProvider implements RealtimeVoiceProvider {
  constructor(private options: OpenAIProviderOptions) {}
  async connect(config: VoiceSessionConfig): Promise<RealtimeVoiceSession> {
    if (!this.options.apiKey.trim()) throw new Error('OPENAI_API_KEY is not configured');
    if (!config.sdpOffer || config.sdpOffer.length > 64000 || !config.sdpOffer.startsWith('v=0'))
      throw new Error('A valid bounded WebRTC SDP offer is required');
    if (!config.instructions.trim() || config.instructions.length > 60000)
      throw new Error('Voice instructions must contain 1–60000 characters');
    const model = this.options.model ?? 'gpt-realtime';
    if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('Invalid OpenAI model name');
    const fetcher = this.options.fetcher ?? fetch;
    const form = new FormData();
    form.set('sdp', config.sdpOffer);
    form.set('session', JSON.stringify({ ...configuration(config), model }));
    config.onEvent({ type: 'state', state: 'connecting', provider: 'openai' });
    let callId: string | undefined;
    let session: OpenAISession | undefined;
    const hangup = async () => {
      if (!callId) return;
      try {
        const response = await fetcher(`${API}/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.options.apiKey}` },
          signal: AbortSignal.timeout(this.options.hangupTimeoutMs ?? 5000),
          redirect: 'error',
        });
        if (!response.ok && response.status !== 404) throw new Error('hangup failed');
      } catch {
        config.onEvent({
          type: 'error',
          message: 'OpenAI media hangup could not be confirmed. Close the browser voice connection.',
        });
      }
    };
    try {
      const response = await fetcher(`${API}/v1/realtime/calls`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(this.options.setupTimeoutMs ?? 15000),
        redirect: 'error',
      });
      if (response.status !== 201)
        throw new Error(
          `OpenAI call setup failed (HTTP ${response.status}); check model access, key and quota`,
        );
      callId = openAICallId(response.headers.get('location'));
      const answer = await response.text();
      if (!answer.startsWith('v=0') || answer.length > 64000)
        throw new Error('OpenAI returned an invalid SDP answer');
      let socket: ProviderSocket;
      try {
        socket = (this.options.socketFactory ?? ((url, options) => new WebSocket(url, options)))(
          `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`,
          { headers: { Authorization: `Bearer ${this.options.apiKey}` }, maxPayload: 1_048_576 },
        );
      } catch {
        throw new Error('OpenAI sideband connection could not be created');
      }
      session = new OpenAISession(socket, config, answer, hangup, this.options.setupTimeoutMs ?? 15000);
      await session.initialize();
      return session;
    } catch (error) {
      if (session) await session.close();
      else {
        await hangup();
        config.onEvent({ type: 'state', state: 'closed', provider: 'openai' });
      }
      const message =
        error instanceof Error && /^OpenAI |^Invalid OpenAI /.test(error.message)
          ? error.message
          : 'OpenAI connection failed or timed out';
      throw new Error(message);
    }
  }
}

class OpenAISession implements RealtimeVoiceSession {
  readonly capabilities = { transport: 'webrtc-sideband' as const, resumption: false };
  private ready = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private setupTimer: ReturnType<typeof setTimeout> | undefined;
  private sessionId: string | undefined;
  private updateSent = false;
  private readyAt = Date.now();
  private activeResponse: string | undefined;
  private requestedResponse = false;
  private wantsResponse = false;
  private userSpeaking = false;
  private discardRequestedResponse = false;
  private cancelledResponses = new Set<string>();
  private cancelEventIds = new Set<string>();
  private completedResponses = new Set<string>();
  private seenCalls = new Set<string>();
  private cancelledCalls = new Set<string>();
  private pendingCalls = new Map<string, { name: string; batchId: string }>();
  private batches = new Map<string, Set<string>>();
  private transcripts = new Map<string, { role: 'user' | 'assistant'; text: string }>();
  private finalTranscripts = new Set<string>();
  constructor(
    private socket: ProviderSocket,
    private config: VoiceSessionConfig,
    readonly sdpAnswer: string,
    private hangup: () => Promise<void>,
    private setupTimeout: number,
  ) {}
  private emit(event: VoiceEvent) {
    this.config.onEvent(event);
  }
  initialize(): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.setupTimer = setTimeout(() => this.fail('OpenAI sideband setup timed out'), this.setupTimeout);
    this.socket.on('message', (raw: unknown) => this.receive(raw));
    this.socket.on('error', () => this.fail('OpenAI sideband transport error'));
    this.socket.on('close', (code: number) => {
      if (!this.closed) {
        this.emit({
          type: 'error',
          message: `OpenAI sideband closed (code ${Number.isInteger(code) ? code : 'unknown'})`,
        });
        void this.close();
      }
    });
    return promise;
  }
  private send(value: unknown) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN)
      throw new Error('OpenAI sideband is not open');
    if (this.socket.bufferedAmount > 1_048_576) throw new Error('OpenAI sideband send buffer is full');
    this.socket.send(JSON.stringify(value), (error) => {
      if (error) this.fail('OpenAI sideband send failed');
    });
  }
  private ensureReady() {
    if (!this.ready || this.closed) throw new Error('OpenAI voice session is not ready');
  }
  private receive(raw: unknown) {
    if (this.closed) return;
    let event: Record<string, any>;
    try {
      const data = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : '';
      if (!data || data.length > 1_048_576) throw new Error();
      const parsed: unknown = JSON.parse(data);
      if (!isRecord(parsed) || typeof parsed.type !== 'string') throw new Error();
      event = parsed;
    } catch {
      this.emit({ type: 'error', message: 'Ignored malformed OpenAI event' });
      return;
    }
    try {
      this.dispatch(event);
    } catch {
      this.fail('OpenAI protocol processing failed');
    }
  }
  private dispatch(event: Record<string, any>) {
    if (event.type === 'error') {
      // Never expose raw provider error fields: they can contain prompts or authorization material.
      if (typeof event.error?.event_id === 'string' && this.cancelEventIds.delete(event.error.event_id))
        return;
      this.fail('OpenAI rejected a realtime operation; check configuration, model access and quota');
      return;
    }
    if (event.type === 'session.created' && !this.updateSent) {
      this.sessionId = typeof event.session?.id === 'string' ? event.session.id : undefined;
      this.updateSent = true;
      this.send({ type: 'session.update', event_id: randomUUID(), session: configuration(this.config) });
      return;
    }
    if (event.type === 'session.updated' && this.updateSent && !this.ready) {
      if (this.sessionId && event.session?.id !== this.sessionId) return;
      this.ready = true;
      clearTimeout(this.setupTimer);
      this.emit({ type: 'state', state: 'ready', provider: 'openai' });
      this.emit({ type: 'metric', name: 'sideband_ready', value: Date.now() - this.readyAt, unit: 'ms' });
      this.resolveReady();
      return;
    }
    if (!this.ready) return;
    if (event.type === 'response.created') {
      const responseId = typeof event.response?.id === 'string' ? event.response.id : 'unknown';
      this.activeResponse = responseId;
      this.requestedResponse = false;
      if (this.discardRequestedResponse) {
        this.cancelledResponses.add(responseId);
        this.discardRequestedResponse = false;
      }
      this.emit({ type: 'turn', phase: 'started' });
      return;
    }
    if (event.type === 'response.done') {
      this.responseDone(event.response);
      return;
    }
    if (event.type === 'input_audio_buffer.speech_started') {
      this.userSpeaking = true;
      this.wantsResponse = false;
      this.markResponseCancelled();
      this.cancelTools();
      this.emit({ type: 'interrupted', source: 'provider' });
      return;
    }
    if (event.type === 'input_audio_buffer.committed') {
      this.userSpeaking = false;
      this.requestResponse();
      return;
    }
    if (event.type === 'output_audio_buffer.cleared') {
      this.emit({ type: 'interrupted', source: 'provider' });
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.delta')
      this.transcript(event, 'user', false);
    if (event.type === 'conversation.item.input_audio_transcription.completed')
      this.transcript(event, 'user', true);
    if (
      event.type === 'response.output_audio_transcript.delta' ||
      event.type === 'response.output_text.delta'
    )
      this.transcript(event, 'assistant', false);
    if (event.type === 'response.output_audio_transcript.done' || event.type === 'response.output_text.done')
      this.transcript(event, 'assistant', true);
    if (event.type === 'conversation.item.input_audio_transcription.failed')
      this.emit({ type: 'error', message: 'OpenAI could not transcribe an input audio turn' });
    // WebRTC carries media directly. Raw audio/unknown/private reasoning events are never forwarded.
  }
  private responseDone(response: unknown) {
    if (!isRecord(response) || typeof response.id !== 'string' || this.completedResponses.has(response.id))
      return;
    if (this.completedResponses.size >= 1000) {
      this.fail('OpenAI session response limit exceeded');
      return;
    }
    this.completedResponses.add(response.id);
    if (!this.activeResponse || this.activeResponse === response.id) {
      this.activeResponse = undefined;
      this.requestedResponse = false;
    }
    if (response.status !== 'completed' || this.cancelledResponses.has(response.id)) {
      this.pump();
      return;
    }
    const hasFunctionCalls =
      Array.isArray(response.output) &&
      response.output.some((item: unknown) => isRecord(item) && item.type === 'function_call');
    const requests: Array<{ id: string; name: string; input: unknown }> = [];
    for (const item of (Array.isArray(response.output) ? response.output : []).slice(0, 32)) {
      if (!isRecord(item) || item.type !== 'function_call' || item.status !== 'completed') continue;
      if (
        typeof item.call_id !== 'string' ||
        !item.call_id ||
        item.call_id.length > 200 ||
        typeof item.name !== 'string' ||
        !this.config.tools.some((t) => t.name === item.name) ||
        typeof item.arguments !== 'string' ||
        item.arguments.length > 32000
      ) {
        this.emit({ type: 'error', message: 'Ignored invalid OpenAI function call' });
        continue;
      }
      if (this.seenCalls.has(item.call_id)) continue;
      if (this.seenCalls.size >= 1000) {
        this.fail('OpenAI session tool limit exceeded');
        return;
      }
      let input: unknown;
      try {
        input = JSON.parse(item.arguments);
      } catch {
        this.emit({ type: 'error', message: 'Ignored malformed OpenAI function arguments' });
        continue;
      }
      if (!isRecord(input)) {
        this.emit({ type: 'error', message: 'Ignored non-object OpenAI function arguments' });
        continue;
      }
      this.seenCalls.add(item.call_id);
      requests.push({ id: item.call_id, name: item.name, input });
    }
    if (requests.length) {
      const pending = new Set(requests.map((call) => call.id));
      this.batches.set(response.id, pending);
      for (const call of requests) this.pendingCalls.set(call.id, { name: call.name, batchId: response.id });
      for (const call of requests) this.emit({ type: 'toolCall', ...call });
    }
    // A tool-producing response is an intermediate step, not the end of a support turn.
    // Completeness checks must run only after the assistant finishes the final response.
    if (!hasFunctionCalls) this.emit({ type: 'turn', phase: 'completed' });
    this.pump();
  }
  private transcript(event: Record<string, any>, role: 'user' | 'assistant', final: boolean) {
    if (typeof event.item_id !== 'string' || event.item_id.length > 200) return;
    const key = `${role}:${event.item_id}`;
    if (this.finalTranscripts.has(key)) return;
    if (this.finalTranscripts.size + this.transcripts.size >= 2000 && !this.transcripts.has(key)) {
      this.fail('OpenAI session transcript limit exceeded');
      return;
    }
    const old = this.transcripts.get(key)?.text ?? '';
    const value = final
      ? typeof event.transcript === 'string'
        ? event.transcript
        : typeof event.text === 'string'
          ? event.text
          : old
      : old + (typeof event.delta === 'string' ? event.delta : '');
    const text = value.slice(0, 16000);
    if (!text) return;
    if (final) {
      this.transcripts.delete(key);
      this.finalTranscripts.add(key);
    } else this.transcripts.set(key, { role, text });
    this.emit({ type: 'transcript', role, text, final, itemId: event.item_id });
  }
  private requestResponse() {
    this.wantsResponse = true;
    this.pump();
  }
  private pump() {
    if (
      !this.ready ||
      this.closed ||
      !this.wantsResponse ||
      this.requestedResponse ||
      this.activeResponse ||
      this.pendingCalls.size ||
      this.userSpeaking
    )
      return;
    this.wantsResponse = false;
    this.requestedResponse = true;
    this.send({ type: 'response.create', event_id: randomUUID() });
  }
  private cancelTools() {
    const ids = [...this.pendingCalls.keys()];
    for (const id of ids) this.cancelledCalls.add(id);
    this.pendingCalls.clear();
    this.batches.clear();
    if (ids.length) this.emit({ type: 'toolCancelled', ids });
  }
  private markResponseCancelled() {
    if (this.activeResponse) this.cancelledResponses.add(this.activeResponse);
    else if (this.requestedResponse) this.discardRequestedResponse = true;
  }
  private fail(message: string) {
    if (this.closed) return;
    this.emit({ type: 'error', message });
    this.rejectReady(new Error(message));
    void this.close();
  }
  async sendAudio(_base64: string, _sampleRate: number): Promise<void> {
    throw new Error('OpenAI WebRTC audio uses the browser media track, not PCM WebSocket frames');
  }
  async sendText(text: string): Promise<void> {
    this.ensureReady();
    if (!text.trim() || text.length > 8000) throw new Error('Voice text must contain 1–8000 characters');
    this.send({
      type: 'conversation.item.create',
      event_id: randomUUID(),
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    this.requestResponse();
  }
  async sendToolResult(result: ToolExecutionResult): Promise<void> {
    this.ensureReady();
    if (this.cancelledCalls.has(result.id)) return;
    const pending = this.pendingCalls.get(result.id);
    if (!pending || pending.name !== result.name) throw new Error('No matching pending OpenAI tool call');
    const output = JSON.stringify(result);
    if (output.length > 256000) throw new Error('Voice tool result exceeds transport limit');
    this.send({
      type: 'conversation.item.create',
      event_id: randomUUID(),
      item: { type: 'function_call_output', call_id: result.id, output },
    });
    this.pendingCalls.delete(result.id);
    const batch = this.batches.get(pending.batchId);
    batch?.delete(result.id);
    if (batch?.size === 0) {
      this.batches.delete(pending.batchId);
      this.requestResponse();
    }
  }
  async interrupt(): Promise<void> {
    this.ensureReady();
    this.wantsResponse = false;
    this.markResponseCancelled();
    this.cancelTools();
    if (this.activeResponse || this.requestedResponse) {
      const eventId = randomUUID();
      this.cancelEventIds.add(eventId);
      this.send({
        type: 'response.cancel',
        event_id: eventId,
        ...(this.activeResponse && this.activeResponse !== 'unknown'
          ? { response_id: this.activeResponse }
          : {}),
      });
    }
    this.send({ type: 'output_audio_buffer.clear', event_id: randomUUID() });
    this.emit({ type: 'interrupted', source: 'local' });
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    clearTimeout(this.setupTimer);
    if (!this.ready) this.rejectReady(new Error('OpenAI sideband closed before setup completed'));
    this.cancelTools();
    this.transcripts.clear();
    // Set closed before socket.close: synchronous close callbacks cannot re-enter cleanup.
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000, 'User ended voice session');
    else this.socket.terminate?.();
    this.closePromise = this.hangup().finally(() =>
      this.emit({ type: 'state', state: 'closed', provider: 'openai' }),
    );
    return this.closePromise;
  }
}
