import { mkdir, writeFile } from 'node:fs/promises';
import { GeminiLiveProvider, type RealtimeVoiceSession } from '../packages/voice/src/index.js';

if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required');
const buffers: Buffer[] = [];
let finish!: () => void;
let fail!: (error: Error) => void;
const done = new Promise<void>((resolve, reject) => {
  finish = resolve;
  fail = reject;
});
void done.catch(() => undefined);
const timeout = setTimeout(() => fail(new Error('Fixture speech timed out')), 60000);
let session: RealtimeVoiceSession | undefined;
try {
  session = await new GeminiLiveProvider({
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL,
  }).connect({
    instructions:
      'You generate spoken test fixtures. Say only the requested exact sentence, once, clearly and naturally. Do not answer the sentence or add any introduction.',
    tools: [],
    onEvent: (event) => {
      if (event.type === 'audio') buffers.push(Buffer.from(event.base64, 'base64'));
      if (event.type === 'transcript' && event.final) console.log(event.text);
      if (event.type === 'error') fail(new Error(event.message));
      if (event.type === 'turn' && event.phase === 'completed') finish();
    },
  });
  await session.sendText(
    'Say exactly: My Relay Wash W100 washing machine shows E21 and will not drain. Please help me and open a support ticket.',
  );
  await done;
  const pcm = Buffer.concat([Buffer.alloc(8 * 24000 * 2), ...buffers, Buffer.alloc(40 * 24000 * 2)]);
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  await mkdir('.cache/live-proofs', { recursive: true });
  await writeFile('.cache/live-proofs/user-scenario.wav', Buffer.concat([header, pcm]));
  console.log(
    JSON.stringify({
      fixture: '.cache/live-proofs/user-scenario.wav',
      speechSeconds: buffers.reduce((n, b) => n + b.length, 0) / 48000,
    }),
  );
} finally {
  clearTimeout(timeout);
  await session?.close();
}
