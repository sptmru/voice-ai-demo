import { expect, test } from '@playwright/test';

// These exercise the deterministic text workflow without opening billed provider calls.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    for (const provider of Object.values(config.providers) as { configured: boolean }[])
      provider.configured = false;
    await route.fulfill({ response, json: config });
  });
});

test('repair advice persists evidence and an after-call report', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Live workspace', exact: true }).click();
  await page.getByLabel('Demo scenario').selectOption('repair-advice');
  await expect(page.getByRole('heading', { name: 'Every conversation. In context.' })).toBeVisible();
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page.getByText('In session', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Try: My Relay Wash W100/ }).click();
  await expect(page.getByRole('heading', { name: 'A clear diagnosis. A concrete next step.' })).toBeVisible({
    timeout: 100000,
  });
  await expect(page.locator('.sources .source-card').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/m1-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'End session' }).click();
  await expect(page.getByText('AFTER-CALL REPORT', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Session history', exact: true }).first().click();
  await page.locator('.history-row').first().click();
  expect(errors).toEqual([]);
});

test('repair approval is explicit and mobile layout fits', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Live workspace', exact: true }).click();
  await page.getByLabel('Demo scenario').selectOption('repair-advice');
  await page.getByLabel('Demo scenario').selectOption('repair-status');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await page.getByLabel('Message the support agent').fill('Please approve repair REP-1042');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm quote approval' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm quote approval' }).click();
  await expect(page.getByRole('button', { name: 'Confirm quote approval' })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/m1-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('knowledge search exposes vector and lexical evidence', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Live workspace', exact: true }).click();
  await page.getByLabel('Demo scenario').selectOption('repair-advice');
  await page
    .getByRole('button', { name: /Knowledge base/ })
    .first()
    .click();
  await page.getByLabel('Knowledge domain').selectOption('repair');
  await page.getByLabel('Search knowledge').fill('workshop diagnosis repair warranty');
  await page.getByRole('button', { name: 'Search knowledge', exact: true }).click();
  await expect(page.locator('.search-results .source-card').first()).toBeVisible({ timeout: 100000 });
  await page.locator('.search-results .source-card summary').first().click();
  await expect(page.locator('.search-results .source-card').first()).toContainText('Semantic');
});

test('uploaded knowledge becomes searchable from the dashboard', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Live workspace', exact: true }).click();
  await page.getByLabel('Demo scenario').selectOption('repair-advice');
  await page
    .getByRole('button', { name: /Knowledge base/ })
    .first()
    .click();
  await page.getByLabel('Choose knowledge document').setInputFiles({
    name: 'aurora-routing.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(
      '# Aurora test routing\n\nFor the fictional Aurora route, use the diagnostic marker AURORA-7281. This is a document-upload test, and does not authorize changes to any workshop record.',
    ),
  });
  await page.getByRole('button', { name: 'Upload & index' }).click();
  await expect(page.getByRole('status')).toContainText('Aurora test routing is searchable', {
    timeout: 60000,
  });
  await page.getByLabel('Search knowledge').fill('AURORA-7281');
  await page.getByRole('button', { name: 'Search knowledge', exact: true }).click();
  await expect(page.locator('.search-results .source-card').first()).toContainText('Aurora test routing');
  await page.locator('.search-results .source-card summary').first().click();
  await expect(page.locator('.search-results .source-card').first()).toContainText('AURORA-7281');
  const card = page.locator('.document-card').filter({ hasText: 'Aurora test routing' });
  await card.getByRole('button', { name: 'Delete document Aurora test routing', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({ path: 'test-results/delete-document.png', fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Delete document Aurora test routing', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete document', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(card).toHaveCount(0);
  await expect(page.locator('.search-results')).not.toContainText('Aurora test routing');
  await page.getByRole('button', { name: 'Search knowledge', exact: true }).click();
  await expect(page.locator('.search-results')).not.toContainText('Aurora test routing');
});

test('session deletion confirms, reports a failed delete, and clears the selected session', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Live workspace', exact: true }).click();
  await page.getByLabel('Demo scenario').selectOption('repair-advice');
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/api/sessions') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  const { session } = await (await created).json();
  await expect(page.getByText('In session', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Session history', exact: true }).first().click();
  const remove = page.getByRole('button', { name: `Delete session ${session.id.slice(0, 8)}`, exact: true });
  await remove.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({ path: 'test-results/delete-session-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(remove).toBeVisible();
  await page.route(`**/api/sessions/${session.id}`, async (route) => {
    if (route.request().method() === 'DELETE')
      await route.fulfill({
        status: 409,
        json: { error: 'An operation is already in progress. Please wait.' },
      });
    else await route.continue();
  });
  await remove.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete session', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('already in progress');
  await expect(remove).toBeVisible();
  await page.unroute(`**/api/sessions/${session.id}`);
  await page.getByRole('dialog').getByRole('button', { name: 'Delete session', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(remove).toHaveCount(0);
  expect((await page.request.get(`/api/sessions/${session.id}`)).status()).toBe(404);
  await page.getByRole('button', { name: 'Live workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start session', exact: true })).toBeVisible();
  await expect(page.getByText('In session', { exact: true })).toHaveCount(0);
});
