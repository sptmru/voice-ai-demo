import { describe, expect, it, vi } from 'vitest';
import type { RealtimeVoiceSession, VoiceSessionConfig } from '../packages/voice/src/index.js';
import { pcm16Wav, runVoiceProof } from '../scripts/lib/voice-proof.js';
function fakeProvider(play: (config: VoiceSessionConfig, session: RealtimeVoiceSession) => void) {
  let config!: VoiceSessionConfig;
  const session: RealtimeVoiceSession = {
    capabilities: { transport: 'websocket-pcm', resumption: false },
    sendAudio: vi.fn(async () => {}),
    sendImage: vi.fn(async () => {}),
    sendText: vi.fn(async () => {
      play(config, session);
    }),
    sendToolResult: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const provider = {
    connect: vi.fn(async (c: VoiceSessionConfig) => {
      config = c;
      return session;
    }),
  };
  return { provider, session };
}
const finalAnswer = (config: VoiceSessionConfig) => {
  config.onEvent({ type: 'audio', base64: Buffer.alloc(16).toString('base64'), sampleRate: 24000 });
  config.onEvent({
    type: 'transcript',
    role: 'assistant',
    text: 'Repair warranty is ninety days.',
    final: true,
    itemId: 'answer',
  });
  config.onEvent({ type: 'turn', phase: 'completed' });
};
describe('bounded voice proof harness', () => {
  it('waits for the real tool result before recording the resulting audio/transcript', async () => {
    const f = fakeProvider((config, session) => {
      session.sendToolResult = vi.fn(async () => {
        finalAnswer(config);
      });
      config.onEvent({
        type: 'toolCall',
        id: 'knowledge',
        name: 'search_knowledge_base',
        input: { query: 'warranty' },
      });
      config.onEvent({ type: 'turn', phase: 'completed' });
    });
    const executeTool = vi.fn(async () => ({
      id: 'knowledge',
      name: 'search_knowledge_base',
      status: 'completed' as const,
      result: { status: 'supported' },
    }));
    const result = await runVoiceProof({
      provider: f.provider,
      instructions: 'Use sources',
      tools: [],
      input: 'Warranty?',
      executeTool,
      timeoutMs: 1000,
    });
    expect(result.failure).toBeUndefined();
    expect(result.audioBytes).toBe(16);
    expect(result.transcript).toContain('ninety days');
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(f.session.sendAudio).not.toHaveBeenCalled();
    expect(f.session.close).toHaveBeenCalledTimes(1);
  });
  it('records provider interruption without misrepresenting it as a microphone test', async () => {
    const f = fakeProvider((config) => {
      config.onEvent({ type: 'interrupted', source: 'provider' });
      finalAnswer(config);
    });
    const result = await runVoiceProof({
      provider: f.provider,
      instructions: 'Support',
      tools: [],
      input: 'Warranty?',
      executeTool: vi.fn(),
      timeoutMs: 1000,
    });
    expect(result.interruptions).toBe(1);
    expect(result.transcript).toContain('warranty');
    expect(f.session.sendAudio).not.toHaveBeenCalled();
  });
  it('captures provider errors and closes the connection', async () => {
    const f = fakeProvider((config) => config.onEvent({ type: 'error', message: 'Provider unavailable' }));
    const result = await runVoiceProof({
      provider: f.provider,
      instructions: 'Support',
      tools: [],
      input: 'Warranty?',
      executeTool: vi.fn(),
      timeoutMs: 1000,
    });
    expect(result.failure).toBe('Provider unavailable');
    expect(f.session.close).toHaveBeenCalledTimes(1);
  });
  it('enforces a tool budget before executing excess provider requests', async () => {
    const f = fakeProvider((config) => {
      for (let i = 0; i < 3; i++)
        config.onEvent({ type: 'toolCall', id: String(i), name: 'search_knowledge_base', input: {} });
    });
    const executeTool = vi.fn();
    const result = await runVoiceProof({
      provider: f.provider,
      instructions: 'Support',
      tools: [],
      input: 'Warranty?',
      executeTool,
      maxToolCalls: 2,
      timeoutMs: 1000,
    });
    expect(result.failure).toContain('tool count');
    expect(executeTool.mock.calls.length).toBeLessThanOrEqual(2);
  });
  it('bounds a silent provider and creates a playable mono PCM16 WAV artifact', async () => {
    const f = fakeProvider(() => {});
    const result = await runVoiceProof({
      provider: f.provider,
      instructions: 'Support',
      tools: [],
      input: 'Warranty?',
      executeTool: vi.fn(),
      timeoutMs: 10,
    });
    expect(result.failure).toContain('timeout');
    expect(f.session.close).toHaveBeenCalledTimes(1);
    const wav = pcm16Wav(Buffer.alloc(16));
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt32LE(40)).toBe(16);
  });
});
