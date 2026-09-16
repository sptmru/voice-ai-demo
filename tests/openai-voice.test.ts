import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTools } from '../packages/core/src/tools.js';
import { OpenAIRealtimeProvider, openAICallId } from '../packages/voice/src/openai.js';
import { GeminiLiveProvider } from '../packages/voice/src/gemini.js';
import type { ProviderSocket, VoiceEvent } from '../packages/voice/src/types.js';

class Socket extends EventEmitter implements ProviderSocket {
  readyState = 0;
  bufferedAmount = 0;
  sent: Record<string, any>[] = [];
  send(data: string, callback?: (error?: Error) => void) {
    this.sent.push(JSON.parse(data));
    callback?.();
  }
  close(code = 1000) {
    this.readyState = 3;
    this.emit('close', code);
  }
  terminate() {
    this.close(1006);
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
  server(event: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }
}
const tools = createTools();
const call = (id: string, name: string, input: unknown) => ({
  type: 'function_call',
  status: 'completed',
  call_id: id,
  name,
  arguments: JSON.stringify(input),
});
const response = (id: string, output: unknown[] = [], status = 'completed') => ({
  type: 'response.done',
  response: { id, status, output },
});
async function fixture(
  options: {
    status?: number;
    location?: string;
    answer?: string;
    setupTimeout?: number;
    hangupStatus?: number;
  } = {},
) {
  const socket = new Socket();
  const events: VoiceEvent[] = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
    String(url).endsWith('/hangup')
      ? new Response(null, { status: options.hangupStatus ?? 200 })
      : new Response(options.answer ?? 'v=0\r\ns=Relay test\r\n', {
          status: options.status ?? 201,
          headers: { Location: options.location ?? '/v1/realtime/calls/rtc_test' },
        }),
  );
  const factory = vi.fn((_url: string) => socket);
  const provider = new OpenAIRealtimeProvider({
    apiKey: 'sk-test-do-not-expose',
    fetcher,
    socketFactory: factory,
    setupTimeoutMs: options.setupTimeout ?? 1000,
  });
  const promise = provider.connect({
    instructions: 'Support telecom users with actual tools.',
    tools,
    onEvent: (e) => events.push(e),
    sdpOffer: 'v=0\r\ns=Browser\r\n',
  });
  // Advance HTTP response/body microtasks without using timers in timeout tests.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const ready = async () => {
    socket.open();
    socket.server({ type: 'session.created', session: { id: 'session-1', type: 'realtime' } });
    socket.server({ type: 'session.updated', session: { id: 'session-1', type: 'realtime' } });
    return promise;
  };
  return { socket, events, fetcher, factory, promise, ready };
}
afterEach(() => vi.useRealTimers());

describe('OpenAI GA WebRTC and trusted sideband adapter', () => {
  it('creates multipart SDP call, waits for session-created/update acknowledgment, and returns WebRTC capabilities', async () => {
    const f = await fixture();
    let connected = false;
    void f.promise.then(() => {
      connected = true;
    });
    expect(f.fetcher.mock.calls[0][0]).toBe('https://api.openai.com/v1/realtime/calls');
    const request = f.fetcher.mock.calls[0][1]!;
    expect(request.redirect).toBe('error');
    const form = request.body as FormData;
    expect(form.get('sdp')).toBe('v=0\r\ns=Browser\r\n');
    const initial = JSON.parse(String(form.get('session')));
    expect(initial.type).toBe('realtime');
    expect(initial.model).toBe('gpt-realtime');
    expect(initial.audio.input.turn_detection).toMatchObject({
      create_response: false,
      interrupt_response: true,
    });
    expect(initial.tools.map((tool: { name: string }) => tool.name)).toEqual(tools.map((tool) => tool.name));
    expect(initial.tools[0].parameters.$schema).toBeUndefined();
    expect(f.factory.mock.calls[0][0]).toBe('wss://api.openai.com/v1/realtime?call_id=rtc_test');
    f.socket.open();
    await Promise.resolve();
    expect(connected).toBe(false);
    expect(f.socket.sent).toHaveLength(0);
    f.socket.server({ type: 'session.created', session: { id: 'session-1' } });
    expect(f.socket.sent.at(-1)?.type).toBe('session.update');
    expect(f.socket.sent.at(-1)?.session.model).toBeUndefined();
    f.socket.server({ type: 'session.updated', session: { id: 'wrong-session' } });
    await Promise.resolve();
    expect(connected).toBe(false);
    f.socket.server({ type: 'session.updated', session: { id: 'session-1' } });
    const session = await f.promise;
    expect(session.sdpAnswer).toContain('v=0');
    expect(session.capabilities.transport).toBe('webrtc-sideband');
    await expect(session.sendAudio('AAAA', 16000)).rejects.toThrow('browser media track');
    await session.close();
  });
  it('never sends server authorization to an arbitrary Location target', () => {
    expect(openAICallId('https://api.openai.com/v1/realtime/calls/rtc_opaque-123')).toBe('rtc_opaque-123');
    for (const location of [
      'https://hostile.example/v1/realtime/calls/rtc_x',
      '//hostile.example/v1/realtime/calls/rtc_x',
      'http://api.openai.com/v1/realtime/calls/rtc_x',
      '/v1/realtime/calls/a?x=1',
      '/v1/realtime/calls/a#fragment',
      '/v1/realtime/calls/a/hangup',
      'https://user:pass@api.openai.com/v1/realtime/calls/a',
    ])
      expect(() => openAICallId(location)).toThrow('Invalid');
  });
  it('rejects missing keys or SDP before network calls', async () => {
    const fetcher = vi.fn();
    const config = { instructions: 'Support', tools: [], onEvent: () => {}, sdpOffer: 'v=0' };
    await expect(new OpenAIRealtimeProvider({ apiKey: '', fetcher }).connect(config)).rejects.toThrow(
      'OPENAI_API_KEY',
    );
    await expect(
      new OpenAIRealtimeProvider({ apiKey: 'test', fetcher }).connect({ ...config, sdpOffer: undefined }),
    ).rejects.toThrow('SDP');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reports HTTP failure without revealing the response body or credential', async () => {
    const f = await fixture({ status: 401, answer: 'secret provider body sk-test-do-not-expose' });
    await expect(f.promise).rejects.toThrow('HTTP 401');
    expect(f.factory).not.toHaveBeenCalled();
    expect(JSON.stringify(f.events)).not.toContain('sk-test-do-not-expose');
  });
  it('hangs up a created call after invalid SDP or sideband setup timeout', async () => {
    const invalid = await fixture({ answer: 'not SDP' });
    await expect(invalid.promise).rejects.toThrow('invalid SDP');
    expect(invalid.fetcher.mock.calls.at(-1)?.[0]).toContain('/rtc_test/hangup');
    vi.useFakeTimers();
    const timed = await fixture({ setupTimeout: 50 });
    const failure = expect(timed.promise).rejects.toThrow('setup timed out');
    await vi.advanceTimersByTimeAsync(51);
    await failure;
    expect(timed.socket.readyState).toBe(3);
    expect(timed.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/hangup'))).toHaveLength(1);
  });
  it('batches completed response tools and sends only one continuation after every result', async () => {
    const f = await fixture();
    const session = await f.ready();
    f.socket.server({ type: 'response.function_call_arguments.delta', call_id: 'partial', delta: '{}' });
    f.socket.server(response('r1', [call('c1', 'get_customer', {}), call('c2', 'get_account', {})]));
    f.socket.server(response('r1', [call('c1', 'get_customer', {}), call('c2', 'get_account', {})]));
    expect(f.events.filter((e) => e.type === 'toolCall')).toHaveLength(2);
    expect(f.events.filter((e) => e.type === 'turn' && e.phase === 'completed')).toHaveLength(0);
    await session.sendToolResult({
      id: 'c1',
      name: 'get_customer',
      status: 'completed',
      result: { company: 'Acme Ltd' },
    });
    expect(f.socket.sent.filter((e) => e.type === 'response.create')).toHaveLength(0);
    await session.sendToolResult({
      id: 'c2',
      name: 'get_account',
      status: 'completed',
      result: { balance: 245.5 },
    });
    expect(f.socket.sent.filter((e) => e.type === 'response.create')).toHaveLength(1);
    const outputs = f.socket.sent.filter((e) => e.item?.type === 'function_call_output');
    expect(outputs.map((e) => e.item.call_id)).toEqual(['c1', 'c2']);
    expect(JSON.parse(outputs[0].item.output).result.company).toBe('Acme Ltd');
    await expect(
      session.sendToolResult({ id: 'c1', name: 'get_customer', status: 'completed' }),
    ).rejects.toThrow('No matching');
    await session.close();
  });
  it('does not run canceled, partial, malformed or unregistered function calls', async () => {
    const f = await fixture();
    const session = await f.ready();
    f.socket.server(response('canceled', [call('no', 'get_customer', {})], 'cancelled'));
    f.socket.server(
      response('partial', [
        { ...call('partial', 'get_customer', {}), status: 'incomplete' },
        { ...call('bad', 'get_customer', {}), arguments: 'not JSON' },
        call('unknown', 'not_registered', {}),
      ]),
    );
    expect(f.events.filter((e) => e.type === 'toolCall')).toHaveLength(0);
    await session.close();
  });
  it('serializes text and VAD response requests to avoid overlapping active responses', async () => {
    const f = await fixture();
    const session = await f.ready();
    await session.sendText('First message');
    await session.sendText('Second message');
    expect(f.socket.sent.filter((e) => e.type === 'response.create')).toHaveLength(1);
    f.socket.server({ type: 'response.created', response: { id: 'first' } });
    f.socket.server(response('first'));
    expect(f.socket.sent.filter((e) => e.type === 'response.create')).toHaveLength(2);
    f.socket.server({ type: 'response.created', response: { id: 'second' } });
    f.socket.server({ type: 'input_audio_buffer.speech_started' });
    f.socket.server({ type: 'input_audio_buffer.committed' });
    expect(f.socket.sent.filter((e) => e.type === 'response.create')).toHaveLength(2);
    f.socket.server(response('second', [], 'cancelled'));
    expect(f.socket.sent.filter((e) => e.type === 'response.create')).toHaveLength(3);
    await session.close();
  });
  it('interrupts active WebRTC generation, clears output audio and drops canceled tool results', async () => {
    const f = await fixture();
    const session = await f.ready();
    await session.interrupt();
    expect(f.socket.sent.filter((e) => e.type === 'response.cancel')).toHaveLength(0);
    expect(f.socket.sent.at(-1)?.type).toBe('output_audio_buffer.clear');
    f.socket.server({ type: 'response.created', response: { id: 'speaking' } });
    await session.interrupt();
    expect(f.socket.sent.at(-2)).toMatchObject({ type: 'response.cancel', response_id: 'speaking' });
    f.socket.server(response('speaking', [], 'cancelled'));
    f.socket.server(response('tools', [call('late', 'get_customer', {})]));
    f.socket.server({ type: 'input_audio_buffer.speech_started' });
    expect(f.events.some((e) => e.type === 'toolCancelled' && e.ids.includes('late'))).toBe(true);
    const count = f.socket.sent.length;
    await session.sendToolResult({ id: 'late', name: 'get_customer', status: 'completed', result: {} });
    expect(f.socket.sent).toHaveLength(count);
    await session.close();
  });
  it('ignores late completed tool output from an interrupted response and tolerates a raced cancel acknowledgment', async () => {
    const f = await fixture();
    const session = await f.ready();
    f.socket.server({ type: 'response.created', response: { id: 'interrupted' } });
    await session.interrupt();
    const eventId = f.socket.sent.find((e) => e.type === 'response.cancel')!.event_id;
    f.socket.server({ type: 'error', error: { event_id: eventId, message: 'A cancel raced completion' } });
    f.socket.server(response('interrupted', [call('must-not-run', 'get_customer', {})]));
    expect(f.events.some((e) => e.type === 'toolCall')).toBe(false);
    expect(f.events.some((e) => e.type === 'state' && e.state === 'closed')).toBe(false);
    await session.close();
  });
  it('merges transcript deltas by item ID and never forwards raw audio or private reasoning', async () => {
    const f = await fixture();
    const session = await f.ready();
    f.socket.server({ type: 'response.output_audio_transcript.delta', item_id: 'out-1', delta: 'Checking ' });
    f.socket.server({ type: 'response.output_audio_transcript.delta', item_id: 'out-1', delta: 'trunk' });
    f.socket.server({
      type: 'response.output_audio_transcript.done',
      item_id: 'out-1',
      transcript: 'Checking trunk.',
    });
    f.socket.server({
      type: 'response.output_audio_transcript.done',
      item_id: 'out-1',
      transcript: 'Checking trunk.',
    });
    f.socket.server({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'in-1',
      transcript: 'Calls fail',
    });
    f.socket.server({ type: 'response.output_audio.delta', delta: 'base64' });
    f.socket.server({ type: 'response.reasoning.delta', delta: 'private reasoning' });
    const finals = f.events.filter(
      (e): e is Extract<VoiceEvent, { type: 'transcript' }> => e.type === 'transcript' && e.final,
    );
    expect(finals.map((e) => e.text)).toEqual(['Checking trunk.', 'Calls fail']);
    expect(f.events.some((e) => e.type === 'audio')).toBe(false);
    expect(JSON.stringify(f.events)).not.toContain('private reasoning');
    await session.close();
  });
  it('closes sideband and media once, and reports hangup failure without exposing upstream secrets', async () => {
    const f = await fixture({ hangupStatus: 500 });
    const session = await f.ready();
    await Promise.all([session.close(), session.close()]);
    expect(f.socket.readyState).toBe(3);
    expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/hangup'))).toHaveLength(1);
    expect(
      f.events.some((e) => e.type === 'error' && e.message.includes('hangup could not be confirmed')),
    ).toBe(true);
    expect(f.events.filter((e) => e.type === 'state' && e.state === 'closed')).toHaveLength(1);
  });
});

describe('same support tool script through both provider wire contracts', () => {
  it.each(['gemini', 'openai'] as const)(
    '%s keeps domain tool names, IDs and pending outcomes intact',
    async (providerId) => {
      let socket: Socket;
      let events: VoiceEvent[];
      let session;
      if (providerId === 'openai') {
        const f = await fixture();
        socket = f.socket;
        events = f.events;
        session = await f.ready();
      } else {
        socket = new Socket();
        events = [];
        const provider = new GeminiLiveProvider({ apiKey: 'mock-key', socketFactory: () => socket });
        const promise = provider.connect({
          instructions: 'Support telecom users',
          tools,
          onEvent: (e) => events.push(e),
        });
        socket.open();
        socket.server({ setupComplete: {} });
        session = await promise;
      }
      const steps = [
        { id: 'identity', name: 'get_customer', input: {}, result: { company: 'Acme Ltd' } },
        { id: 'account', name: 'get_account', input: {}, result: { internationalEnabled: true } },
        {
          id: 'reset',
          name: 'reset_trunk_credentials',
          input: { reason: 'User requested' },
          result: { confirmationId: 'approval-1' },
        },
      ];
      for (const step of steps) {
        if (providerId === 'gemini')
          socket.server({
            toolCall: { functionCalls: [{ id: step.id, name: step.name, args: step.input }] },
          });
        else {
          socket.server({ type: 'response.created', response: { id: `r-${step.id}` } });
          socket.server(response(`r-${step.id}`, [call(step.id, step.name, step.input)]));
        }
        expect(events.find((e) => e.type === 'toolCall' && e.id === step.id)).toEqual({
          type: 'toolCall',
          id: step.id,
          name: step.name,
          input: step.input,
        });
        await session.sendToolResult({
          id: step.id,
          name: step.name,
          status: step.id === 'reset' ? 'pending-confirmation' : 'completed',
          result: step.result,
        });
      }
      expect(events.filter((e) => e.type === 'turn' && e.phase === 'completed')).toHaveLength(0);
      if (providerId === 'gemini') socket.server({ serverContent: { turnComplete: true } });
      else {
        socket.server({ type: 'response.created', response: { id: 'final-reply' } });
        socket.server(response('final-reply'));
      }
      expect(events.filter((e) => e.type === 'turn' && e.phase === 'completed')).toHaveLength(1);
      const last =
        providerId === 'gemini'
          ? socket.sent.at(-1)?.toolResponse.functionResponses[0].response.result
          : JSON.parse(
              socket.sent.filter((e) => e.item?.type === 'function_call_output').at(-1)?.item.output,
            );
      expect(last.status).toBe('pending-confirmation');
      expect(last.name).toBe('reset_trunk_credentials');
      await session.close();
    },
  );
});
