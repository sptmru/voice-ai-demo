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

test('repair is the default and a follow-up keeps appliance context with inspectable sources', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('group', { name: 'Repair scenarios' }).getByRole('button')).toHaveCount(3);
  await expect(page.getByRole('button', { name: /Appliance troubleshooting/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Start in text', exact: true }).click();
  await page.getByRole('button', { name: /Try: My Relay Wash W100 washing machine will not drain/ }).click();
  const evidence = page.getByRole('region', { name: 'Answer sources' });
  await expect(evidence).toContainText('Supporting sources found', { timeout: 100000 });
  await evidence.locator('.source-card summary').first().click();
  await expect(evidence.locator('.source-card').first()).toContainText('version');
  await expect(evidence.locator('.source-card').first()).toContainText('E21');
  await page.getByRole('button', { name: 'Try: What is the repair warranty?', exact: true }).click();
  await expect(evidence).toContainText('What is the repair warranty?');
  await expect(evidence.locator('.source-card').first()).toContainText(/Warranty/i);
  await expect(page.locator('.demo-transcript .agent-turn').last()).toContainText(/90 calendar days?/);
  await expect(page.locator('.demo-transcript .agent-turn').last()).not.toContainText('E21');
  await evidence.getByText('How conversation context was used', { exact: true }).click();
  await expect(evidence.locator('.evidence-context')).toContainText('W100');
  await expect(evidence).not.toContainText('Semantic');
  await page.screenshot({ path: 'test-results/repair-evidence-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('repair booking records only an explicitly chosen time', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Book a repair/ }).click();
  await page.getByRole('button', { name: 'Start in text', exact: true }).click();
  await page
    .getByRole('button', { name: /Try: I want to book a diagnosis for my Relay Wash W100 washing machine/ })
    .click();
  await page.getByRole('button', { name: 'Try: Show available times', exact: true }).click();
  await expect(page.locator('.demo-transcript')).toContainText('1.');
  await expect(page.locator('.demo-result-action')).toHaveCount(0);
  await page.getByRole('button', { name: 'Try: Choose option 1', exact: true }).click();
  await expect(page.locator('.demo-result-action')).toContainText('Appointment booked');
  await expect(page.locator('.demo-result-action .demo-badge')).toHaveText('Local demo record');
});

test('repair status comes from a verified request and mobile cards fit', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: /Check repair status/ }).click();
  await page.getByRole('button', { name: 'Start in text', exact: true }).click();
  await page.getByRole('button', { name: 'Try: Check REP-1042', exact: true }).click();
  await expect(page.locator('.demo-transcript')).toContainText('REP-1042');
  await expect(page.locator('.demo-milestones')).toContainText('Checked repair status');
  await expect(page.locator('.demo-transcript .agent-turn').last()).toContainText('awaiting quote approval');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/repair-status-mobile.png', fullPage: true });
});

test('knowledge inspector makes unsupported evidence visible instead of showing an empty success', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByRole('button', { name: /Knowledge base/ })
    .first()
    .click();
  await page.getByLabel('Search knowledge').fill('How do I repair a spaceship engine?');
  await page.getByRole('button', { name: 'Search knowledge', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Answer sources' })).toContainText(
    'Not enough evidence to answer',
    { timeout: 100000 },
  );
  await expect(page.getByRole('region', { name: 'Answer sources' })).toContainText(
    'do not support a complete answer',
  );
});
