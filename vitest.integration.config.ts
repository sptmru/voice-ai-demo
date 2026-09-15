import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
if (existsSync('.env')) loadEnvFile('.env');
// Every suite creates a unique disposable schema. Never silently skip the
// documented integration command when the local stack is available.
process.env.TEST_DATABASE_URL ??=
  process.env.DATABASE_URL ?? 'postgresql://relay:relay_local@127.0.0.1:55432/relay';
export default defineConfig({
  test: {
    include: ['tests/**/*.integration.test.ts'],
    testTimeout: 120000,
    hookTimeout: 180000,
    fileParallelism: false,
  },
});
