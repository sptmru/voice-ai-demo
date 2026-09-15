import { mkdir, writeFile } from 'node:fs/promises';
import { pool, PostgresRepository } from '../packages/db/src/index.js';
import { RagService } from '../packages/rag/src/index.js';
import { SupportRuntime } from '../packages/core/src/runtime.js';
import { SUPPORT_SYSTEM_PROMPT } from '../packages/core/src/prompt.js';
import { GeminiLiveProvider, type RealtimeVoiceSession } from '../packages/voice/src/index.js';

// Explicit opt-in live check. Makes billable/quota-consuming requests with the
// configured key. Stores only fictional demo evidence, never the key/provider URL.
if (!process.env.GEMINI_API_KEY) throw new Error('Set GEMINI_API_KEY in .env');
const repo = new PostgresRepository(pool);
const runtime = new SupportRuntime(repo, new RagService(pool));
const support = await runtime.startSession('carrier-incident');
const startedAt = Date.now();
let voice: RealtimeVoiceSession | undefined;
let operations = Promise.resolve();
let audioBytes = 0;
const chunks: Buffer[] = [];
const transcripts: { role: string; text: string }[] = [];
const tools: string[] = [];
const metrics: unknown[] = [];
let finish!: () => void;
let fail!: (e: Error) => void;
const completed = new Promise<void>((resolve, reject) => {
  finish = resolve;
  fail = reject;
});
const timeout = setTimeout(() => fail(new Error('Live scenario did not complete in 120 seconds')), 120000);
try {
  voice = await new GeminiLiveProvider({
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL,
  }).connect({
    instructions: SUPPORT_SYSTEM_PROMPT,
    tools: runtime.executor.tools
      .filter((t) => t.permission !== 'human-only')
      .map((t) => ({ name: t.name, description: t.description, jsonSchema: t.jsonSchema })),
    onEvent: (event) => {
      if (event.type === 'error') fail(new Error(event.message));
      if (event.type === 'audio') {
        const bytes = Buffer.from(event.base64, 'base64');
        audioBytes += bytes.length;
        if (audioBytes < 20_000_000) chunks.push(bytes);
      }
      if (event.type === 'metric') metrics.push(event);
      if (event.type === 'transcript' && event.final) {
        transcripts.push({ role: event.role, text: event.text });
        console.log(JSON.stringify({ transcript: event.role, text: event.text }));
      }
      if (event.type === 'toolCall')
        operations = operations
          .then(async () => {
            tools.push(event.name);
            console.log(JSON.stringify({ tool: event.name, callId: event.id }));
            const result = await runtime.executeTool(support.id, event);
            await voice?.sendToolResult(result);
          })
          .catch(fail);
      if (event.type === 'turn' && event.phase === 'completed')
        void operations
          .then(async () => {
            const state = await repo.getSession(support.id);
            if (state.outcome && (await repo.getTickets(support.id)).length && audioBytes) finish();
          })
          .catch(fail);
    },
  });
  await voice.sendText(
    'Hi, our outbound calls to UK numbers started failing this morning with SIP 403. Please investigate using our account, call, trunk, number, knowledge and incident tools, open a support ticket, and save the structured outcome with complete_support_case.',
  );
  await completed;
  await operations;
  await voice.close();
  await runtime.endSession(support.id);
  const session = await repo.getSession(support.id);
  const report = {
    verifiedAt: new Date().toISOString(),
    provider: 'gemini',
    model: process.env.GEMINI_MODEL,
    durationMs: Date.now() - startedAt,
    audioBytes,
    tools,
    transcripts,
    metrics,
    sessionId: support.id,
    outcome: session.outcome,
    input: 'text-to-native-audio with actual tool calls; microphone not covered by this script',
  };
  await mkdir('.cache/live-proofs', { recursive: true });
  await writeFile('.cache/live-proofs/gemini-scenario.json', JSON.stringify(report, null, 2));
  const pcm = Buffer.concat(chunks);
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
  await writeFile('.cache/live-proofs/gemini-scenario.wav', Buffer.concat([header, pcm]));
  console.log(
    JSON.stringify({
      success: true,
      sessionId: support.id,
      audioBytes,
      toolCount: tools.length,
      ticketId: session.outcome?.ticketId,
    }),
  );
} finally {
  clearTimeout(timeout);
  await voice?.close();
  await pool.end();
}
