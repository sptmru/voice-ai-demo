import type { ToolCall, ToolExecutionResult } from '../../packages/core/src/executor.js';
import type {
  RealtimeVoiceProvider,
  RealtimeVoiceSession,
  VoiceEvent,
  VoiceTool,
} from '../../packages/voice/src/index.js';

export interface VoiceProofResult {
  transcript: string;
  transcripts: { role: 'user' | 'assistant'; text: string }[];
  audioBytes: number;
  pcm: Buffer;
  toolResults: ToolExecutionResult[];
  metrics: { name: string; value: number; unit: string }[];
  interruptions: number;
  elapsedMs: number;
  failure?: string;
}
/** Synthetic text -> real provider audio. This helper does not simulate a microphone. */
export async function runVoiceProof(options: {
  provider: RealtimeVoiceProvider;
  instructions: string;
  tools: VoiceTool[];
  input: string;
  executeTool(call: ToolCall): Promise<ToolExecutionResult>;
  timeoutMs?: number;
  maxToolCalls?: number;
}): Promise<VoiceProofResult> {
  const started = performance.now();
  const transcripts: VoiceProofResult['transcripts'] = [];
  const frames: Buffer[] = [];
  const metrics: VoiceProofResult['metrics'] = [];
  const toolResults: ToolExecutionResult[] = [];
  let audioBytes = 0;
  let interruptions = 0;
  let toolCalls = 0;
  let settled = false;
  let awaitingToolResponse = false;
  let session: RealtimeVoiceSession | undefined;
  let operations = Promise.resolve();
  let finish!: (failure?: string) => void;
  const done = new Promise<string | undefined>((resolve) => {
    finish = (failure) => {
      if (!settled) {
        settled = true;
        resolve(failure);
      }
    };
  });
  const timer = setTimeout(
    () => finish('Voice proof exceeded its bounded timeout'),
    options.timeoutMs ?? 60000,
  );
  const onEvent = (event: VoiceEvent) => {
    if (settled) return;
    if (event.type === 'error') {
      finish(event.message);
      return;
    }
    if (event.type === 'interrupted') {
      interruptions++;
      return;
    }
    if (event.type === 'metric') metrics.push({ name: event.name, value: event.value, unit: event.unit });
    if (event.type === 'audio') {
      const bytes = Buffer.from(event.base64, 'base64');
      audioBytes += bytes.length;
      if (audioBytes > 8_000_000) {
        finish('Voice proof exceeded its bounded audio size');
        return;
      }
      frames.push(bytes);
      awaitingToolResponse = false;
    }
    if (event.type === 'transcript' && event.final) {
      transcripts.push({ role: event.role, text: event.text });
      if (event.role === 'assistant') awaitingToolResponse = false;
    }
    if (event.type === 'toolCall') {
      if (++toolCalls > (options.maxToolCalls ?? 8)) {
        finish('Voice proof exceeded its bounded tool count');
        return;
      }
      awaitingToolResponse = true;
      operations = operations
        .then(async () => {
          if (settled) return;
          const result = await options.executeTool(event);
          toolResults.push(result);
          if (!settled) await session?.sendToolResult(result);
        })
        .catch(() => finish('Voice proof tool execution failed'));
    }
    if (event.type === 'turn' && event.phase === 'completed') {
      void operations
        .then(() => {
          if (
            !awaitingToolResponse &&
            transcripts.some((item) => item.role === 'assistant' && item.text.trim())
          )
            finish();
        })
        .catch(() => finish('Voice proof turn could not complete'));
    }
  };
  let failure: string | undefined;
  try {
    session = await options.provider.connect({
      instructions: options.instructions,
      tools: options.tools,
      onEvent,
    });
    if (!settled) await session.sendText(options.input);
    failure = await done;
  } catch {
    failure = 'Voice proof connection or input failed';
    finish(failure);
  } finally {
    clearTimeout(timer);
    await operations;
    try {
      await session?.close();
    } catch {
      failure ??= 'Voice proof could not close its provider session';
    }
  }
  return {
    transcript: transcripts
      .filter((item) => item.role === 'assistant')
      .map((item) => item.text)
      .join('\n'),
    transcripts,
    audioBytes,
    pcm: Buffer.concat(frames),
    toolResults,
    metrics,
    interruptions,
    elapsedMs: Math.round(performance.now() - started),
    ...(failure ? { failure } : {}),
  };
}
export function pcm16Wav(pcm: Buffer, sampleRate = 24000): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
