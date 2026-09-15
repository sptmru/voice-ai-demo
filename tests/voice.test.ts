import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTools } from '../packages/core/src/tools.js';
import {
  GeminiLiveProvider,
  geminiSchema,
  type ProviderSocket,
  type VoiceEvent,
} from '../packages/voice/src/index.js';

class MockSocket extends EventEmitter implements ProviderSocket {
  readyState = 0;
  bufferedAmount = 0;
  sent: Record<string, any>[] = [];
  send(data: string, callback?: (error?: Error) => void) {
    this.sent.push(JSON.parse(data));
    callback?.();
  }
  close(code = 1000) {
    this.readyState = 3;
    this.emit('close', code, Buffer.from('closed'));
  }
  terminate() {
    this.close(1006);
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
  server(data: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(data)));
  }
}
function connect(options: { timeout?: number } = {}) {
  const socket = new MockSocket();
  const events: VoiceEvent[] = [];
  const factory = vi.fn(() => socket);
  const provider = new GeminiLiveProvider({
    apiKey: 'super-secret-key',
    socketFactory: factory,
    setupTimeoutMs: options.timeout ?? 1000,
  });
  const promise = provider.connect({
    instructions: 'Use real support tools.',
    tools: createTools(),
    onEvent: (event) => events.push(event),
  });
  socket.open();
  return {
    socket,
    events,
    factory,
    promise,
    ready: async () => {
      socket.server({ setupComplete: {} });
      return promise;
    },
  };
}
afterEach(() => vi.useRealTimers());

describe('Gemini raw Live adapter', () => {
  it('waits for setupComplete and sends nested wire configuration with provider-neutral tools', async () => {
    const f = connect();
    let connected = false;
    void f.promise.then(() => {
      connected = true;
    });
    await Promise.resolve();
    expect(connected).toBe(false);
    const setup = f.socket.sent[0].setup;
    expect(setup.model).toBe('models/gemini-3.1-flash-live-preview');
    expect(setup.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(setup.responseModalities).toBeUndefined();
    expect(setup.inputAudioTranscription).toEqual({});
    expect(setup.outputAudioTranscription).toEqual({});
    const params = setup.tools[0].functionDeclarations.find(
      (t: any) => t.name === 'get_recent_calls',
    ).parameters;
    expect(params.type).toBe('OBJECT');
    expect(params.properties.limit.type).toBe('INTEGER');
    expect(params.$schema).toBeUndefined();
    expect(params.additionalProperties).toBeUndefined();
    const session = await f.ready();
    expect(session.capabilities).toEqual({
      transport: 'websocket-pcm',
      inputSampleRate: 16000,
      outputSampleRate: 24000,
      resumption: false,
    });
    expect(f.events.filter((e) => e.type === 'state').map((e) => e.state)).toEqual(['connecting', 'ready']);
    await session.close();
  });
  it('removes schema metadata while retaining required fields and enum values', () => {
    expect(
      geminiSchema({
        type: 'object',
        $schema: 'ignore',
        additionalProperties: false,
        required: ['severity'],
        properties: { severity: { type: 'string', enum: ['high', 'low'], maxLength: 10 } },
      }),
    ).toEqual({
      type: 'OBJECT',
      required: ['severity'],
      properties: { severity: { type: 'STRING', enum: ['high', 'low'] } },
    });
  });
  it('rejects missing keys without opening a provider socket', async () => {
    const factory = vi.fn();
    const provider = new GeminiLiveProvider({ apiKey: '', socketFactory: factory });
    await expect(provider.connect({ instructions: 'Support', tools: [], onEvent: () => {} })).rejects.toThrow(
      'not configured',
    );
    expect(factory).not.toHaveBeenCalled();
  });
  it('fails bounded setup timeout and does not expose credential-bearing transport errors', async () => {
    vi.useFakeTimers();
    const f = connect({ timeout: 100 });
    const error = expect(f.promise).rejects.toThrow('setup timed out');
    await vi.advanceTimersByTimeAsync(101);
    await error;
    expect(f.socket.readyState).toBe(3);
    expect(JSON.stringify(f.events)).not.toContain('super-secret-key');
    const second = connect();
    const rejected = expect(second.promise).rejects.toThrow('transport error');
    second.socket.emit('error', new Error('url?key=super-secret-key'));
    await rejected;
    expect(JSON.stringify(second.events)).not.toContain('super-secret-key');
  });
  it('sends PCM16 frames and complete text turns; rejects wrong rate, malformed and oversized audio', async () => {
    const f = connect();
    const session = await f.ready();
    await session.sendAudio('AAAAAA==', 16000);
    expect(f.socket.sent.at(-1)).toEqual({
      realtimeInput: { audio: { data: 'AAAAAA==', mimeType: 'audio/pcm;rate=16000' } },
    });
    await session.sendText('Investigate UK 403');
    expect(f.socket.sent.at(-1)).toEqual({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: 'Investigate UK 403' }] }],
        turnComplete: true,
      },
    });
    await expect(session.sendAudio('AAAA', 48000)).rejects.toThrow('PCM16');
    await expect(session.sendAudio('oops!', 16000)).rejects.toThrow('PCM16');
    await expect(session.sendAudio('A'.repeat(200000), 16000)).rejects.toThrow('PCM16');
    f.socket.bufferedAmount = 2_000_000;
    await expect(session.sendAudio('AAAAAA==', 16000)).rejects.toThrow('buffer');
    await session.close();
  });
  it('assembles transcript fragments, finalizes once per turn and emits audio without thought text', async () => {
    const f = connect();
    const session = await f.ready();
    f.socket.server({
      serverContent: {
        inputTranscription: { text: 'UK ' },
        modelTurn: {
          parts: [
            { text: 'private reasoning', thought: true },
            { inlineData: { data: 'AAAAAA==', mimeType: 'audio/pcm;rate=24000' } },
          ],
        },
      },
    });
    f.socket.server({
      serverContent: {
        inputTranscription: { text: 'calls fail' },
        outputTranscription: { text: 'Checking ' },
      },
    });
    f.socket.server({ serverContent: { outputTranscription: { text: 'your trunk.' }, turnComplete: true } });
    const finals = f.events.filter(
      (e): e is Extract<VoiceEvent, { type: 'transcript' }> => e.type === 'transcript' && e.final,
    );
    expect(finals.map((e) => e.text)).toEqual(['UK calls fail', 'Checking your trunk.']);
    expect(f.events.filter((e) => e.type === 'audio')).toHaveLength(1);
    expect(JSON.stringify(f.events)).not.toContain('private reasoning');
    f.socket.server({ serverContent: { turnComplete: true } });
    expect(f.events.filter((e) => e.type === 'transcript' && e.final)).toHaveLength(2);
    await session.close();
  });
  it('maps multiple tool calls and returns exact call IDs with executor results, deduplicating repeats', async () => {
    const f = connect();
    const session = await f.ready();
    const message = {
      toolCall: {
        functionCalls: [
          { id: 'call-1', name: 'get_account', args: {} },
          { id: 'call-2', name: 'get_customer', args: {} },
        ],
      },
    };
    f.socket.server(message);
    f.socket.server(message);
    expect(f.events.filter((e) => e.type === 'toolCall')).toHaveLength(2);
    const result = {
      id: 'call-1',
      name: 'get_account',
      status: 'completed' as const,
      result: { balance: 245.5 },
    };
    await session.sendToolResult(result);
    expect(f.socket.sent.at(-1)).toEqual({
      toolResponse: { functionResponses: [{ id: 'call-1', name: 'get_account', response: { result } }] },
    });
    await expect(session.sendToolResult(result)).rejects.toThrow('No matching');
    await session.close();
  });
  it('returns pending confirmations as pending, without executing or approving them', async () => {
    const f = connect();
    const session = await f.ready();
    f.socket.server({
      toolCall: {
        functionCalls: [
          { id: 'reset-1', name: 'reset_trunk_credentials', args: { reason: 'Authentication failed' } },
        ],
      },
    });
    await session.sendToolResult({
      id: 'reset-1',
      name: 'reset_trunk_credentials',
      status: 'pending-confirmation',
      confirmationId: 'approval-1',
    });
    expect(f.socket.sent.at(-1)?.toolResponse.functionResponses[0].response.result.status).toBe(
      'pending-confirmation',
    );
    await session.close();
  });
  it('honors provider cancellation and drops late tool results', async () => {
    const f = connect();
    const session = await f.ready();
    f.socket.server({ toolCall: { functionCalls: [{ id: 'cancel-1', name: 'get_customer', args: {} }] } });
    f.socket.server({ toolCallCancellation: { ids: ['cancel-1', 'not-requested'] } });
    expect(f.events.at(-1)).toEqual({ type: 'toolCancelled', ids: ['cancel-1'] });
    const count = f.socket.sent.length;
    await session.sendToolResult({ id: 'cancel-1', name: 'get_customer', status: 'completed', result: {} });
    expect(f.socket.sent).toHaveLength(count);
    await session.close();
  });
  it('manual playback interruption does not send invalid automatic-VAD activity events', async () => {
    const f = connect();
    const session = await f.ready();
    const sent = f.socket.sent.length;
    const audio = {
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: 'AAAAAA==', mimeType: 'audio/pcm;rate=24000' } }] },
      },
    };
    f.socket.server(audio);
    await session.interrupt();
    expect(f.events.at(-1)).toEqual({ type: 'interrupted', source: 'local' });
    expect(f.socket.sent).toHaveLength(sent);
    f.socket.server(audio);
    expect(f.events.filter((e) => e.type === 'audio')).toHaveLength(1);
    f.socket.server({ serverContent: { outputTranscription: { text: 'Partly spoken' } } });
    f.socket.server({ serverContent: { interrupted: true } });
    expect(f.events.some((e) => e.type === 'interrupted' && e.source === 'provider')).toBe(true);
    expect(f.events.some((e) => e.type === 'transcript' && e.final && e.text === 'Partly spoken')).toBe(true);
    f.socket.server(audio);
    expect(f.events.filter((e) => e.type === 'audio')).toHaveLength(2);
    await session.close();
  });
  it('handles malformed messages and unknown events without crashing, then cleans up on close', async () => {
    const f = connect();
    const session = await f.ready();
    f.socket.emit('message', Buffer.from('{invalid'));
    f.socket.server({ futureEvent: { ok: true } });
    expect(f.events.some((e) => e.type === 'error' && e.message.includes('malformed'))).toBe(true);
    f.socket.server({ goAway: { timeLeft: '10s' } });
    expect(f.events.at(-1)?.type).toBe('error');
    await session.close();
    expect(f.socket.sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } });
    expect(f.events.filter((e) => e.type === 'state' && e.state === 'closed')).toHaveLength(1);
    await session.close();
    await expect(session.sendText('late')).rejects.toThrow('not ready');
  });
});
