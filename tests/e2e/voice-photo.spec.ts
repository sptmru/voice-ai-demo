import { expect, test } from '@playwright/test';

test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});
for (const [width, workspace] of [
  [1512, false],
  [390, false],
  [1512, true],
] as const) {
  test(`shares and retries a photo while voice stays connected (${width}px, ${workspace ? 'workspace' : 'presentation'})`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await context.grantPermissions(['microphone']);
    await page.route('**/api/config', async (route) => {
      const response = await route.fetch();
      const config = await response.json();
      config.voiceProvider = 'gemini';
      config.providers.gemini.configured = true;
      await route.fulfill({ response, json: config });
    });
    let connections = 0,
      stopped = 0,
      attempts = 0;
    const sentText: string[] = [];
    await page.routeWebSocket(/\/api\/sessions\/[^/]+\/voice$/, (socket) => {
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === 'text') sentText.push(message.text);
        if (message.type === 'start') {
          connections++;
          socket.send(JSON.stringify({ type: 'ready' }));
        }
        if (message.type === 'stop') {
          stopped++;
          socket.close();
        }
      });
    });
    await page.route('**/api/sessions/*/voice/photos', async (route) => {
      attempts++;
      expect(route.request().headers()['content-type']).toContain('multipart/form-data');
      expect(route.request().postDataBuffer()?.toString()).toContain('image/jpeg');
      await route.fulfill(
        attempts === 1
          ? { status: 409, json: { error: 'Photo transport failed. Try again.' } }
          : { status: 201, json: { sent: true } },
      );
    });
    await page.goto('/');
    if (workspace) await page.getByRole('button', { name: 'Live workspace', exact: true }).click();
    await expect(page.locator('body')).not.toContainText('SIP Trunking');
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Disconnect voice', exact: true })).toBeVisible();
    if (!workspace) {
      await expect(page.getByRole('button', { name: 'Try: Talk to an operator', exact: true })).toHaveCount(
        0,
      );
      await page.getByRole('button', { name: 'Try: Can I send you a photo?', exact: true }).click();
      expect(sentText).toEqual(['Can I send you a photo?']);
    }
    await page.getByText('Add a label or error-code photo', { exact: false }).click();
    await page
      .getByLabel('Appliance photo', { exact: true })
      .setInputFiles('tests/fixtures/workshop-label.png');
    await expect(page.getByAltText('Selected appliance label or error display')).toBeVisible();
    await page.getByRole('button', { name: 'Send photo to voice agent', exact: true }).click();
    await expect(page.locator('.photo-intake [role="alert"]')).toContainText('Try again');
    await page.getByRole('button', { name: 'Send photo to voice agent', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Photo sent', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Disconnect voice', exact: true })).toBeVisible();
    expect(connections).toBe(1);
    expect(stopped).toBe(0);
    expect(attempts).toBe(2);
    expect(sentText).toEqual(workspace ? [] : ['Can I send you a photo?']);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({
      path: `test-results/voice-photo-${width}-${workspace ? 'workspace' : 'presentation'}.png`,
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Disconnect voice', exact: true }).click();
    expect(stopped).toBe(1);
  });
}
