import { expect, test } from '@playwright/test';

test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});
test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(['microphone']);
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    config.voiceProvider = 'gemini';
    config.providers.gemini.configured = true;
    await route.fulfill({ response, json: config });
  });
});

test('starting and resetting automatically connect voice to the newly created session', async ({ page }) => {
  const connected: string[] = [];
  const stopped: string[] = [];
  await page.routeWebSocket(/\/api\/sessions\/[^/]+\/voice$/, (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'start') {
        expect(message.provider).toBe('gemini');
        connected.push(socket.url());
        socket.send(JSON.stringify({ type: 'ready' }));
      }
      if (message.type === 'stop') {
        stopped.push(socket.url());
        socket.close();
      }
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Live workspace', exact: true }).click();
  await page.getByLabel('Demo scenario').selectOption('repair-advice');
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/api/sessions') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  const first = (await (await created).json()).session.id;
  await expect(page.getByRole('button', { name: 'Disconnect voice', exact: true })).toBeVisible();
  expect(connected).toHaveLength(1);
  expect(connected[0]).toContain(`/sessions/${first}/voice`);
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unmute microphone', exact: true })).toBeVisible();
  const reset = page.waitForResponse(
    (r) => r.url().endsWith('/api/sessions') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Reset session', exact: true }).click();
  const second = (await (await reset).json()).session.id;
  await expect(page.getByRole('button', { name: 'Disconnect voice', exact: true })).toBeVisible();
  expect(second).not.toBe(first);
  expect(connected).toHaveLength(2);
  expect(connected[1]).toContain(`/sessions/${second}/voice`);
  expect(stopped).toEqual([connected[0]]);
  // Deleting the currently selected conversation must close its microphone/socket too.
  await page.getByRole('button', { name: 'Session history', exact: true }).first().click();
  await page.getByRole('button', { name: `Delete session ${second.slice(0, 8)}`, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete session', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(stopped).toEqual(connected);
  expect((await page.request.get(`/api/sessions/${second}`)).status()).toBe(404);
});

test('denied microphone access preserves the new session and allows text support', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('Microphone permission denied', 'NotAllowedError');
    };
  });
  let voiceConnections = 0;
  await page.routeWebSocket(/\/voice$/, (socket) => {
    voiceConnections++;
    socket.close();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Live workspace', exact: true }).click();
  await page.getByLabel('Demo scenario').selectOption('repair-advice');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page.locator('.error-banner')).toContainText('Microphone permission denied');
  await expect(page.getByText('In session', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Message the support agent')).toBeEnabled();
  expect(voiceConnections).toBe(0);
  await page.getByRole('button', { name: /Try: My Relay Wash W100/ }).click();
  await expect(page.locator('.sources .source-card').first()).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole('button', { name: 'Reconnect voice', exact: true })).toBeVisible();
});

test('presentation text start bypasses microphone and handoff closes an active voice call', async ({
  page,
}) => {
  const connected: string[] = [];
  const stopped: string[] = [];
  await page.routeWebSocket(/\/api\/sessions\/[^/]+\/voice$/, (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'start') {
        connected.push(socket.url());
        socket.send(JSON.stringify({ type: 'ready' }));
      }
      if (message.type === 'stop') {
        stopped.push(socket.url());
        socket.close();
      }
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start in text', exact: true }).click();
  await expect(page.getByText('In session', { exact: true })).toBeVisible();
  expect(connected).toEqual([]);
  await page.getByRole('button', { name: 'Connect voice', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect voice', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Talk to a person', exact: true }).click();
  await expect(page.locator('.demo-handoff-banner')).toBeVisible();
  expect(stopped).toEqual(connected);
  expect(stopped).toHaveLength(1);
  await expect(page.getByRole('button', { name: /^(Connect|Reconnect|Disconnect) voice$/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Live workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Connect voice', exact: true })).toBeDisabled();
});
