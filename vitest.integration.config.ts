import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { databaseUrl } from './packages/db/src/config.js';
if (existsSync('.env')) loadEnvFile('.env');
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
