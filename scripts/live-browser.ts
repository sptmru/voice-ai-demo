import { chromium, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.E2E_BASE_URL || 'http://localhost:3100';
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${resolve('.cache/live-proofs/user-scenario.wav')}%noloop`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const context = await browser.newContext({
  permissions: ['microphone'],
  viewport: { width: 1512, height: 1100 },
});
const page = await context.newPage();
const errors: string[] = [];
const frames: { sent: number; received: number; audioBytes: number; interrupted: number } = {
  sent: 0,
  received: 0,
  audioBytes: 0,
  interrupted: 0,
};
page.on('pageerror', (e) => errors.push(e.message));
page.on('websocket', (socket) => {
  if (!socket.url().includes('/voice')) return;
  socket.on('framesent', () => {
    frames.sent++;
  });
  socket.on('framereceived', (message) => {
    frames.received++;
    try {
      const event = JSON.parse(String(message.payload));
      if (event.type === 'audio') frames.audioBytes += Buffer.from(event.base64, 'base64').length;
      if (event.type === 'interrupted') frames.interrupted++;
    } catch {
      /* Ignore development events. */
    }
  });
});
try {
  await page.goto(base);
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await page.getByRole('button', { name: 'Connect voice', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect voice', exact: true }).waitFor({ timeout: 30000 });
  console.log('Browser microphone and Gemini connection ready');
  await page
    .locator('.user-turn')
    .filter({ hasText: /outbound|UK|four|403/i })
    .first()
    .waitFor({ timeout: 90000 });
  console.log('Synthetic microphone speech transcribed by Gemini');
  await page.locator('.ticket-link').first().waitFor({ timeout: 120000 });
  await page.locator('.outcome-panel').waitFor({ timeout: 120000 });
  await page.locator('.sources .source-card').first().waitFor({ timeout: 90000 });
  await expect
    .poll(async () => JSON.parse((await page.locator('.outcome-json pre').textContent()) || '{}').actions, {
      timeout: 90000,
    })
    .toContain('tool:search_knowledge_base');
  await expect
    .poll(async () => JSON.parse((await page.locator('.outcome-json pre').textContent()) || '{}').actions, {
      timeout: 90000,
    })
    .toContain('tool:get_call_details');
  await page.getByRole('button', { name: 'Stop playback', exact: true }).click();
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await page.getByRole('button', { name: 'Unmute microphone', exact: true }).waitFor();
  await mkdir('.cache/live-proofs', { recursive: true });
  await page.screenshot({ path: '.cache/live-proofs/gemini-browser.png', fullPage: true });
  const report = {
    verifiedAt: new Date().toISOString(),
    input: 'Synthetic speech WAV through Chromium getUserMedia and AudioWorklet, real Gemini Live upstream',
    frames,
    errors,
    transcript: await page.locator('.transcript').innerText(),
    outcome: await page.locator('.outcome-json pre').textContent(),
    toolEvents: await page.locator('.event-card').count(),
    note: 'Tests synthetic microphone capture and audio delivery; does not prove acoustic echo performance with physical speakers.',
  };
  await page.getByRole('button', { name: 'Disconnect voice', exact: true }).click();
  await page.getByRole('button', { name: 'End session', exact: true }).click();
  await page.getByText('AFTER-CALL REPORT', { exact: true }).waitFor();
  await writeFile('.cache/live-proofs/gemini-browser.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  console.log(
    JSON.stringify({
      frames,
      errors,
      alerts: await page
        .getByRole('alert')
        .allTextContents()
        .catch(() => []),
      transcript: await page
        .locator('.transcript')
        .innerText()
        .catch(() => ''),
    }),
  );
  await page
    .screenshot({ path: '.cache/live-proofs/gemini-browser-failure.png', fullPage: true })
    .catch(() => undefined);
  throw error;
} finally {
  await browser.close();
}
