import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { buildScenarioPrompt } from '../packages/core/src/prompt.js';
import { GeminiLiveProvider, type RealtimeVoiceSession } from '../packages/voice/src/index.js';
import { runVoiceProof } from './lib/voice-proof.js';

// Explicit live check using synthetic speech/images only; no database or business writes.
if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required');
const provider = new GeminiLiveProvider({
  apiKey: process.env.GEMINI_API_KEY,
  model: process.env.GEMINI_MODEL,
});
async function speech(text: string) {
  const result = await runVoiceProof({
    provider,
    instructions: 'Generate test speech. Repeat only the requested sentence verbatim. Do not answer it.',
    tools: [],
    input: `Say exactly: ${text}`,
    executeTool: async () => {
      throw new Error('No tools expected');
    },
    timeoutMs: 30000,
  });
  if (result.failure || !result.pcm.length) throw new Error(result.failure || 'No fixture audio');
  // Resample mono PCM16 from provider 24 kHz to microphone 16 kHz.
  const pcm = Buffer.alloc(Math.floor(((result.pcm.length / 2) * 2) / 3) * 2);
  for (let i = 0; i < pcm.length / 2; i++) {
    const position = i * 1.5,
      left = Math.floor(position);
    const a = result.pcm.readInt16LE(left * 2);
    const b = result.pcm.readInt16LE(Math.min(left + 1, result.pcm.length / 2 - 1) * 2);
    pcm.writeInt16LE(Math.round(a + (b - a) * (position - left)), i * 2);
  }
  return pcm;
}
const before = await speech('Can I send you a photo of my refrigerator to check it out?');
const after = await speech('Can you still hear me after I sent you the photo?');
const image = await readFile('tests/fixtures/workshop-label.png');
const turns: { role: string; text: string }[] = [];
let voice: RealtimeVoiceSession | undefined;
let failure = '',
  completed = 0,
  audioBytes = 0,
  inputFrames = 0,
  closing = false;
let microphone = Buffer.alloc(0),
  offset = 0;
let pump: ReturnType<typeof setInterval> | undefined;
async function waitForTurn(previous: number) {
  const deadline = Date.now() + 35000;
  while (completed <= previous && !failure && Date.now() < deadline) await delay(50);
  if (failure || completed <= previous) throw new Error(failure || 'Voice turn timed out');
}
try {
  voice = await provider.connect({
    instructions: buildScenarioPrompt({ scenarioId: 'repair-advice', mode: 'rehearsal' }),
    tools: [],
    onEvent(event) {
      if (event.type === 'audio') audioBytes += Buffer.from(event.base64, 'base64').length;
      if (event.type === 'transcript' && event.final) {
        turns.push({ role: event.role, text: event.text });
        console.log(JSON.stringify(turns.at(-1)));
      }
      if (event.type === 'turn' && event.phase === 'completed') completed++;
      if (event.type === 'error') failure = event.message;
      if (event.type === 'state' && event.state === 'closed' && !closing)
        failure ||= 'Voice closed unexpectedly';
    },
  });
  // Same continuous 20 ms stream as an unmuted browser: speech followed by silence.
  pump = setInterval(() => {
    const chunk = Buffer.alloc(640);
    microphone.copy(chunk, 0, offset, Math.min(offset + 640, microphone.length));
    offset = Math.min(offset + 640, microphone.length);
    inputFrames++;
    void voice!.sendAudio(chunk.toString('base64'), 16000).catch((error: Error) => {
      failure = error.message;
    });
  }, 20);
  microphone = before;
  offset = 0;
  await waitForTurn(0);
  const capabilityReply = turns
    .filter((t) => t.role === 'assistant')
    .map((t) => t.text)
    .join(' ');
  let previous = completed;
  await voice.sendImage(image);
  await waitForTurn(previous);
  const photoReply = turns.filter((t) => t.role === 'assistant').at(-1)?.text || '';
  previous = completed;
  microphone = after;
  offset = 0;
  await waitForTurn(previous);
  const followup = turns.filter((t) => t.role === 'assistant').at(-1)?.text || '';
  const checks = {
    acceptsPhoto: /yes|sure|absolutely|of course/i.test(capabilityReply) && /photo/i.test(capabilityReply),
    readsModel: /w\s*(?:100|one hundred)/i.test(photoReply),
    readsError: /e\s*(?:21|twenty.one)/i.test(photoReply),
    respondsAfterPhoto:
      /yes|hear you/i.test(followup) && turns.some((t) => t.role === 'user' && /hear me/i.test(t.text)),
    audioContinues: audioBytes > 0 && inputFrames > 0 && !failure,
  };
  const report = {
    at: new Date().toISOString(),
    model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-live-preview',
    checks,
    turns,
    audioBytes,
    inputFrames,
    completed,
  };
  await mkdir('.cache/live-proofs', { recursive: true });
  await writeFile('.cache/live-proofs/voice-photo-continuous.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(checks));
  if (Object.values(checks).some((ok) => !ok)) process.exitCode = 1;
} finally {
  closing = true;
  clearInterval(pump);
  await voice?.close();
}
