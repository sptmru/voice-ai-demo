import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts'],
    exclude: ['tests/**/*.integration.test.ts'],
    testTimeout: 20000,
  },
});
