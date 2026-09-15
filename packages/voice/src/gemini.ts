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

const isRecord = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_AUDIO_BASE64 = 192_000;

/** Translate only Gemini's supported schema vocabulary. Domain Zod remains authoritative. */
export function geminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const translated: Record<string, unknown> = {};
  if (typeof schema.type === 'string') translated.type = schema.type.toUpperCase();
  for (const key of ['description', 'enum', 'required', 'nullable'])
    if (schema[key] !== undefined) translated[key] = schema[key];
  if (isRecord(schema.properties))
    translated.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        geminiSchema(isRecord(value) ? value : {}),
      ]),
    );
  if (isRecord(schema.items)) translated.items = geminiSchema(schema.items);
  return translated;
}

export interface GeminiProviderOptions {
  apiKey: string;
  model?: string;
  socketFactory?: SocketFactory;
  setupTimeoutMs?: number;
}

export class GeminiLiveProvider implements RealtimeVoiceProvider {
  constructor(private options: GeminiProviderOptions) {}
  async connect(config: VoiceSessionConfig): Promise<RealtimeVoiceSession> {
    if (!this.options.apiKey.trim()) throw new Error('GEMINI_API_KEY is not configured');
    if (!config.instructions.trim() || config.instructions.length > 60000)
      throw new Error('Voice instructions must contain 1–60000 characters');
    const model = this.options.model ?? 'gemini-3.1-flash-live-preview';
    if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('Invalid Gemini model name');
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(this.options.apiKey)}`;
    // API keys in the provider URL must never appear in emitted errors or application logs.
    let socket: ProviderSocket;
    try {
      socket = (this.options.socketFactory ?? ((url, opts) => new WebSocket(url, opts)))(url, {
        maxPayload: 1_048_576,
      });
    } catch {
      throw new Error('Gemini connection could not be created');
    }
    const session = new GeminiSession(socket, config, this.options.setupTimeoutMs ?? 15000);
    await session.initialize(model);
    return session;
  }
}

class GeminiSession implements RealtimeVoiceSession {
  readonly capabilities = {
    transport: 'websocket-pcm' as const,
    inputSampleRate: 16000,
    outputSampleRate: 24000,
    resumption: false,
  };
  private ready = false;
  private closed = false;
  private turnActive = false;
  private dropAudioUntilBoundary = false;
  private firstAudioAt: number | null = null;
  private firstInputRecorded = false;
  private startAt = Date.now();
  private pendingCalls = new Map<string, string>();
  private seenCalls = new Set<string>();
  private cancelled = new Set<string>();
  private userText = '';
  private assistantText = '';
  private userItem = randomUUID();
  private assistantItem = randomUUID();
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private socket: ProviderSocket,
    private config: VoiceSessionConfig,
    private setupTimeoutMs: number,
  ) {}
  private emit(event: VoiceEvent) {
    this.config.onEvent(event);
  }
  initialize(model: string): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.emit({ type: 'state', state: 'connecting', provider: 'gemini' });
    this.timer = setTimeout(() => this.fail('Gemini setup timed out'), this.setupTimeoutMs);
    this.socket.on('open', () => {
      try {
        this.sendRaw({
          setup: {
            model: `models/${model}`,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } },
            },
            systemInstruction: { parts: [{ text: this.config.instructions }] },
            tools: [
              {
                functionDeclarations: this.config.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: geminiSchema(tool.jsonSchema),
                })),
              },
            ],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            realtimeInputConfig: {
              automaticActivityDetection: { disabled: false },
              activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
            },
            contextWindowCompression: { slidingWindow: {} },
          },
        });
      } catch {
        this.fail('Gemini setup could not be sent');
      }
    });
    this.socket.on('message', (data: unknown) => this.receive(data));
    this.socket.on('error', () => this.fail('Gemini transport error; check key, model access and network'));
    this.socket.on('close', (code: number) => {
      if (!this.closed && code !== 1000)
        this.emit({
          type: 'error',
          message: `Gemini connection closed (code ${Number.isInteger(code) ? code : 'unknown'})`,
        });
      this.finish();
    });
    return ready;
  }
  private sendRaw(value: unknown) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN)
      throw new Error('Gemini connection is not open');
    if (this.socket.bufferedAmount > 1_048_576)
      throw new Error('Voice send buffer is full; audio cannot keep up');
    this.socket.send(JSON.stringify(value), (error) => {
      if (error) this.fail('Gemini transport send failed');
    });
  }
  private ensureReady() {
    if (!this.ready || this.closed) throw new Error('Gemini session is not ready');
  }
  private receive(raw: unknown) {
    if (this.closed) return;
    let message: Record<string, any>;
    try {
      const encoded =
        typeof raw === 'string'
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString('utf8')
            : raw instanceof ArrayBuffer
              ? Buffer.from(raw).toString('utf8')
              : '';
      if (!encoded || encoded.length > 1_048_576) throw new Error('invalid');
      const parsed: unknown = JSON.parse(encoded);
      if (!isRecord(parsed)) throw new Error('invalid');
      message = parsed;
    } catch {
      this.emit({ type: 'error', message: 'Ignored malformed Gemini message' });
      return;
    }
    if (message.error) {
      this.fail('Gemini rejected the request; verify model access, quota and configuration');
      return;
    }
    if (isRecord(message.setupComplete) && !this.ready) {
      this.ready = true;
      clearTimeout(this.timer);
      this.emit({ type: 'state', state: 'ready', provider: 'gemini' });
      this.emit({ type: 'metric', name: 'connection_ready', value: Date.now() - this.startAt, unit: 'ms' });
      this.readyResolve();
      return;
    }
    if (!this.ready) return;
    const content = message.serverContent;
    if (isRecord(content)) {
      if (content.interrupted === true) {
        this.emit({ type: 'interrupted', source: 'provider' });
        this.flushTranscripts();
        this.turnActive = false;
        this.dropAudioUntilBoundary = false;
      }
      const parts = content.modelTurn?.parts;
      if (Array.isArray(parts) && !content.interrupted && !this.dropAudioUntilBoundary)
        for (const part of parts) {
          if (!isRecord(part) || part.thought === true) continue;
          const inline = part.inlineData;
          if (
            isRecord(inline) &&
            typeof inline.data === 'string' &&
            typeof inline.mimeType === 'string' &&
            inline.mimeType.startsWith('audio/pcm')
          ) {
            if (
              inline.data.length > MAX_AUDIO_BASE64 ||
              !BASE64.test(inline.data) ||
              Buffer.from(inline.data, 'base64').length % 2 !== 0
            ) {
              this.emit({ type: 'error', message: 'Ignored invalid Gemini audio frame' });
              continue;
            }
            const rate = inline.mimeType.match(/rate=(\d+)/)?.[1];
            if (rate && Number(rate) !== 24000) {
              this.emit({ type: 'error', message: 'Unsupported Gemini output audio sample rate' });
              continue;
            }
            if (!this.turnActive) {
              this.turnActive = true;
              this.emit({ type: 'turn', phase: 'started' });
            }
            if (this.firstAudioAt !== null) {
              this.emit({
                type: 'metric',
                name: 'first_input_to_first_audio',
                value: Date.now() - this.firstAudioAt,
                unit: 'ms',
              });
              this.firstAudioAt = null;
            }
            this.emit({ type: 'audio', base64: inline.data, sampleRate: 24000 });
          }
        }
      this.transcription('user', content.inputTranscription?.text);
      this.transcription('assistant', content.outputTranscription?.text);
      if (content.turnComplete === true) {
        this.flushTranscripts();
        this.turnActive = false;
        this.dropAudioUntilBoundary = false;
        this.emit({ type: 'turn', phase: 'completed' });
      }
    }
    if (isRecord(message.toolCall) && Array.isArray(message.toolCall.functionCalls)) {
      for (const call of message.toolCall.functionCalls.slice(0, 32)) {
        if (
          !isRecord(call) ||
          typeof call.id !== 'string' ||
          call.id.length > 200 ||
          !call.id ||
          typeof call.name !== 'string' ||
          !this.config.tools.some((t) => t.name === call.name) ||
          !isRecord(call.args ?? {})
        ) {
          this.emit({ type: 'error', message: 'Ignored invalid Gemini tool call' });
          continue;
        }
        if (this.seenCalls.has(call.id)) continue;
        if (this.seenCalls.size >= 1000) {
          this.fail('Gemini session tool limit exceeded');
          return;
        }
        this.seenCalls.add(call.id);
        this.pendingCalls.set(call.id, call.name);
        this.emit({ type: 'toolCall', id: call.id, name: call.name, input: call.args ?? {} });
      }
    }
    if (Array.isArray(message.toolCallCancellation?.ids)) {
      const ids = message.toolCallCancellation.ids.filter(
        (id: unknown): id is string => typeof id === 'string' && this.pendingCalls.has(id),
      );
      for (const id of ids) {
        this.cancelled.add(id);
        this.pendingCalls.delete(id);
      }
      if (ids.length) this.emit({ type: 'toolCancelled', ids });
    }
    if (isRecord(message.goAway))
      this.emit({
        type: 'error',
        message:
          'Gemini connection will expire soon. End this voice call and reconnect; automatic resumption is not enabled.',
      });
  }
  private transcription(role: 'user' | 'assistant', fragment: unknown) {
    if (typeof fragment !== 'string' || !fragment) return;
    if (role === 'user') this.userText = (this.userText + fragment).slice(0, 16000);
    else this.assistantText = (this.assistantText + fragment).slice(0, 16000);
    this.emit({
      type: 'transcript',
      role,
      text: role === 'user' ? this.userText : this.assistantText,
      final: false,
      itemId: role === 'user' ? this.userItem : this.assistantItem,
    });
  }
  private flushTranscripts() {
    if (this.userText)
      this.emit({
        type: 'transcript',
        role: 'user',
        text: this.userText,
        final: true,
        itemId: this.userItem,
      });
    if (this.assistantText)
      this.emit({
        type: 'transcript',
        role: 'assistant',
        text: this.assistantText,
        final: true,
        itemId: this.assistantItem,
      });
    this.userText = '';
    this.assistantText = '';
    this.userItem = randomUUID();
    this.assistantItem = randomUUID();
  }
  private fail(message: string) {
    if (this.closed) return;
    this.emit({ type: 'error', message });
    this.readyReject(new Error(message));
    this.finish();
    this.socket.terminate?.();
  }
  private finish() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    if (!this.ready) this.readyReject(new Error('Gemini disconnected before setup completed'));
    this.flushTranscripts();
    this.pendingCalls.clear();
    this.emit({ type: 'state', state: 'closed', provider: 'gemini' });
  }
  async sendAudio(base64: string, sampleRate: number): Promise<void> {
    this.ensureReady();
    if (
      sampleRate !== 16000 ||
      !base64 ||
      base64.length > MAX_AUDIO_BASE64 ||
      !BASE64.test(base64) ||
      Buffer.from(base64, 'base64').length % 2 !== 0
    )
      throw new Error('Expected bounded mono PCM16 audio at 16000 Hz');
    // This measures first submitted frame to first output, including time spent speaking.
    if (!this.firstInputRecorded) {
      this.firstInputRecorded = true;
      this.firstAudioAt = Date.now();
    }
    this.sendRaw({ realtimeInput: { audio: { data: base64, mimeType: 'audio/pcm;rate=16000' } } });
  }
  async sendText(text: string): Promise<void> {
    this.ensureReady();
    if (!text.trim() || text.length > 8000) throw new Error('Voice text must contain 1–8000 characters');
    if (!this.firstInputRecorded) {
      this.firstInputRecorded = true;
      this.firstAudioAt = Date.now();
    }
    this.sendRaw({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } });
  }
  async sendToolResult(result: ToolExecutionResult): Promise<void> {
    this.ensureReady();
    if (this.cancelled.has(result.id)) return;
    const name = this.pendingCalls.get(result.id);
    if (!name || name !== result.name) throw new Error('No matching pending Gemini tool call');
    const message = { toolResponse: { functionResponses: [{ id: result.id, name, response: { result } }] } };
    if (JSON.stringify(message).length > 256000) throw new Error('Voice tool result exceeds transport limit');
    this.sendRaw(message);
    this.pendingCalls.delete(result.id);
  }
  async interrupt(): Promise<void> {
    this.ensureReady();
    // Gemini has no explicit cancel command with automatic VAD. Clear local playback;
    // microphone speech triggers the provider's real interruption event.
    this.dropAudioUntilBoundary = this.turnActive;
    this.emit({ type: 'interrupted', source: 'local' });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.ready && this.socket.readyState === WebSocket.OPEN)
      try {
        this.sendRaw({ realtimeInput: { audioStreamEnd: true } });
      } catch {
        /* Continue cleanup. */
      }
    this.finish();
    this.socket.close(1000, 'User ended voice session');
  }
}
