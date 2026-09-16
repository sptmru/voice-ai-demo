import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    for (const provider of Object.values(config.providers) as { configured: boolean }[])
      provider.configured = false;
    await route.fulfill({ response, json: config });
  });
});

test('presentation books an explicit slot and labels local results honestly', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Appliance repair, with a clear next step.' }),
  ).toBeVisible();
  await expect(page.getByRole('group', { name: 'Repair scenarios' }).getByRole('button')).toHaveCount(3);
  await page.locator('.demo-other-scenarios summary').click();
  await page.getByLabel('All demo scenarios').selectOption('appointment-booking');
  await page.getByRole('button', { name: 'Start in text', exact: true }).click();
  await page.getByRole('button', { name: 'Try: Show available times', exact: true }).click();
  await expect(page.locator('.demo-transcript')).toContainText('1.');
  await page.getByRole('button', { name: 'Try: Book option 1', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Conversation result' })).toContainText('Appointment booked');
  await expect(page.locator('.demo-result .demo-badge')).toHaveText('Local demo record');
  await expect(page.getByRole('link', { name: 'Open in Google Calendar' })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/business-appointment-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Explore technical details' }).click();
  await expect(page.getByRole('heading', { name: 'Agent activity', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Hide technical details' }).click();
  await expect(page.getByRole('heading', { name: 'Agent activity', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('sales lead captures the supplied need, budget and timeline', async ({ page }) => {
  await page.goto('/');
  await page.locator('.demo-other-scenarios summary').click();
  await page.getByLabel('All demo scenarios').selectOption('lead-qualification');
  await page.getByRole('button', { name: 'Start in text', exact: true }).click();
  await page.getByRole('button', { name: /Try: Need: automate incoming calls/ }).click();
  const result = page.getByRole('region', { name: 'Conversation result' });
  await expect(result).toContainText('Qualified lead saved');
  await expect(result).toContainText('$5000');
  await expect(result).toContainText('next month');
  await expect(result).toContainText('automate incoming calls');
  await expect(result.locator('.demo-badge')).toHaveText('Local demo record');
});

test('retail change requires confirmation and mobile presentation fits', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.locator('.demo-other-scenarios summary').click();
  await page.getByLabel('All demo scenarios').selectOption('order-support');
  await page.getByRole('button', { name: 'Start in text', exact: true }).click();
  await page.getByRole('button', { name: 'Try: Where is order ORD-1042?', exact: true }).click();
  await expect(page.locator('.demo-transcript')).toContainText('ORD-1042');
  await page
    .getByRole('button', { name: 'Try: Change delivery to 25 Market Street, London', exact: true })
    .click();
  await expect(page.locator('.demo-transcript')).toContainText('25 Market Street');
  await expect(page.locator('.demo-result-action')).toHaveCount(0);
  await page.getByRole('button', { name: 'Try: Confirm delivery change', exact: true }).click();
  await expect(page.locator('.demo-result-action')).toContainText('Delivery change requested');
  await expect(page.locator('.demo-result-action')).toContainText('25 Market Street, London');
  await expect(page.locator('.demo-result-action')).toContainText('pending-review');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/business-retail-mobile.png', fullPage: true });
});

test('operator accepts a handoff and both sides exchange text with AI paused', async ({ page }) => {
  await page.goto('/');
  await page.locator('.demo-other-scenarios summary').click();
  await page.getByLabel('All demo scenarios').selectOption('appointment-booking');
  await page.getByRole('button', { name: 'Start in text', exact: true }).click();
  await page.getByRole('button', { name: 'Try: Show available times', exact: true }).click();
  await page.getByRole('button', { name: 'Talk to a person', exact: true }).click();
  await expect(page.locator('.demo-handoff-banner')).toContainText('context is ready');
  await expect(page.getByRole('button', { name: 'Connect voice', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open operator desk', exact: true }).click();
  await expect(page.locator('.operator-queue-item')).toHaveCount(1);
  await expect(page.locator('.operator-brief')).toContainText('requested a team member');
  await page.getByRole('button', { name: 'Accept conversation', exact: true }).click();
  await page
    .getByLabel('Message as team member')
    .fill('Hi, I have your availability request. How can I help?');
  await page.getByRole('button', { name: 'Send operator message', exact: true }).click();
  await expect(page.locator('.operator-conversation .demo-transcript')).toContainText('TEAM MEMBER');
  await page.getByRole('button', { name: 'Demo', exact: true }).click();
  await expect(page.locator('.demo-transcript')).toContainText('Hi, I have your availability request.');
  const assistantTurns = await page
    .locator('.demo-transcript .turn-author')
    .filter({ hasText: 'RELAY AGENT' })
    .count();
  await page
    .getByLabel('Message the support agent')
    .fill('Thank you, please help me arrange a longer consultation.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.demo-transcript')).toContainText('Thank you, please help');
  await expect(page.locator('.demo-transcript .turn-author').filter({ hasText: 'RELAY AGENT' })).toHaveCount(
    assistantTurns,
  );
  await page.getByRole('button', { name: 'Operator desk', exact: true }).click();
  await expect(page.locator('.operator-conversation .demo-transcript')).toContainText(
    'Thank you, please help',
  );
  await page.screenshot({ path: 'test-results/operator-desktop.png', fullPage: true });
});
