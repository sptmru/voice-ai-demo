import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { databaseUrl } from '../packages/db/src/config.js';
import { PostgresRepository } from '../packages/db/src/index.js';
import { migrate } from '../packages/db/src/migrate.js';
import { SupportRuntime } from '../packages/core/src/runtime.js';
import { buildScenarioPrompt } from '../packages/core/src/prompt.js';
import { RagService } from '../packages/rag/src/index.js';
import { GeminiLiveProvider } from '../packages/voice/src/index.js';
import { seedOperationalData, seedRepairKnowledge } from './seed.js';
import { runVoiceProof, pcm16Wav } from './lib/voice-proof.js';

if (process.env.EVAL_ALLOW_LIVE !== '1' || !process.argv.includes('--live'))
  throw new Error(
    'This makes a billable Gemini Live connection. Set EVAL_ALLOW_LIVE=1 and pass --live explicitly.',
  );
if (!process.env.GEMINI_API_KEY)
  throw new Error('Configure GEMINI_API_KEY locally before requesting the live voice proof.');
for (const key of ['GOOGLE_CALENDAR_ID', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'])
  delete process.env[key];
const schema = `relay_voice_eval_${randomUUID().replaceAll('-', '')}`;
const connectionString = process.env.TEST_DATABASE_URL || databaseUrl();
const admin = new pg.Pool({ connectionString });
const database = new pg.Pool({ connectionString, options: `-c search_path=${schema},public` });
const reportPath = resolve(process.env.VOICE_EVAL_REPORT || 'artifacts/repair-voice-proof.json');
let created = false;
try {
  await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
  await admin.query(`CREATE SCHEMA ${schema}`);
  created = true;
  await migrate(database);
  await seedOperationalData(database);
  await seedRepairKnowledge(database);
  const repo = new PostgresRepository(database);
  const rag = new RagService(database);
  await rag.warmup();
  const runtime = new SupportRuntime(repo, rag);
  const session = await runtime.startSession('repair-advice', 'rehearsal');
  const input =
    'What warranty do you give on performed repair work and installed parts? Please check your repair documents and answer briefly in English, naming the source.';
  await repo.appendEvent(session.id, 'transcript', {
    role: 'user',
    text: input,
    final: true,
    mode: 'voice-text-proof',
  });
  // The proof asks only about a policy. No booking, dispatch or external-write tools are exposed.
  const allowed = new Set([
    'get_customer',
    'update_repair_context',
    'search_knowledge_base',
    'complete_support_case',
  ]);
  const result = await runVoiceProof({
    provider: new GeminiLiveProvider({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL }),
    instructions:
      buildScenarioPrompt(session) +
      '\nThis is a rehearsal policy inquiry. Answer using the returned evidence and cite its document title and section. Keep the spoken answer to two or three sentences.',
    tools: runtime.executor.tools
      .filter((tool) => allowed.has(tool.name))
      .map((tool) => ({ name: tool.name, description: tool.description, jsonSchema: tool.jsonSchema })),
    input,
    timeoutMs: 60000,
    maxToolCalls: 8,
    executeTool: (call) => runtime.executeTool(session.id, call),
  });
  const events = await repo.getEvents(session.id);
  const retrievals = events.filter((event) => event.type === 'retrieval.completed');
  const sources = retrievals
    .filter((event) => event.payload.status === 'supported')
    .flatMap(
      (event) =>
        (event.payload.chunks ?? []) as {
          source: string;
          document: string;
          section: string;
          content: string;
        }[],
    );
  const checks = [
    { name: 'provider-completed', pass: !result.failure },
    { name: 'native-audio-received', pass: result.audioBytes > 0 },
    { name: 'assistant-transcript-received', pass: result.transcript.trim().length > 0 },
    {
      name: 'real-knowledge-tool-used',
      pass: result.toolResults.some(
        (tool) => tool.name === 'search_knowledge_base' && tool.status === 'completed',
      ),
    },
    {
      name: 'active-warranty-source',
      pass: sources.some((source) => source.source === 'docs/knowledge/repair/repair-warranty.md'),
    },
    { name: 'correct-warranty-term', pass: /\b90\b|ninety/iu.test(result.transcript) },
    {
      name: 'spoken-source-attribution',
      pass: sources.some(
        (source) =>
          result.transcript.toLowerCase().includes(source.document.toLowerCase()) ||
          result.transcript.toLowerCase().includes(source.section.toLowerCase()),
      ),
    },
    { name: 'no-side-effect-actions', pass: (await repo.getActions(session.id)).length === 0 },
    { name: 'english-response', pass: !/[а-яё]/iu.test(result.transcript) },
  ];
  const { pcm, ...proof } = result;
  const report = {
    verifiedAt: new Date().toISOString(),
    provider: 'gemini',
    model: process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-live-preview',
    mode: 'rehearsal',
    input,
    transport: 'synthetic text input -> actual Gemini native audio and transcript',
    microphone: false,
    speechRecognition: false,
    liveInterruptionTested: false,
    checks,
    pass: checks.every((check) => check.pass),
    ...proof,
    evidence: retrievals.map((event) => event.payload),
    note: 'One bounded provider connection; real local RAG/tools in an isolated schema. Google credentials disabled and no external-write tools exposed. Microphone, acoustic playback and real-user barge-in are not covered. Provider interruption/error behavior is covered by deterministic adapter/harness tests.',
  };
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  if (pcm.length) await writeFile(reportPath.replace(/\.json$/, '') + '.wav', pcm16Wav(pcm));
  console.log(
    JSON.stringify(
      {
        provider: report.provider,
        model: report.model,
        pass: report.pass,
        audioBytes: result.audioBytes,
        elapsedMs: result.elapsedMs,
        checks,
        failure: result.failure,
        report: reportPath,
      },
      null,
      2,
    ),
  );
  if (!report.pass) process.exitCode = 1;
} finally {
  await database.end();
  if (created) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
