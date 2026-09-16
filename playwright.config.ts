import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  // Exercise the real API rate limit without bursting all demo workflows from one IP.
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3100',
    trace: 'retain-on-failure',
    launchOptions: { slowMo: Number(process.env.E2E_SLOW_MO_MS ?? 200) },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1512, height: 1100 } } },
  ],
  reporter: [['list']],
});
