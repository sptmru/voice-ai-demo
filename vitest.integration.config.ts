import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { databaseUrl } from './packages/db/src/config.js';
if (existsSync('.env')) loadEnvFile('.env');
// Tests must never inherit real provider credentials from the developer's .env.
// Individual adapter tests pass explicit fake credentials and mocked transports.
for (const key of [
  'GOOGLE_CALENDAR_ID',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
])
  process.env[key] = '';
// Every suite creates a unique disposable schema. Never silently skip the
// documented integration command when the local stack is available.
process.env.TEST_DATABASE_URL ||= databaseUrl();
export default defineConfig({
  test: {
    include: ['tests/**/*.integration.test.ts'],
    testTimeout: 120000,
    hookTimeout: 180000,
    fileParallelism: false,
  },
});
