import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    for (const provider of Object.values(config.providers) as { configured: boolean }[])
      provider.configured = false;
    await route.fulfill({ response, json: config });
  });
});

async function bookRepair(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Book a repair/ }).click();
  const created = page.waitForResponse(
    (response) => response.url().endsWith('/api/sessions') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Start in text', exact: true }).click();
  const { session } = await (await created).json();
  await page.getByRole('button', { name: /Try: I want to book a diagnosis for my Relay Wash W100/ }).click();
  await page.getByRole('button', { name: 'Try: Show available times', exact: true }).click();
  await page.getByRole('button', { name: 'Try: Choose option 1', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Current appointment' })).toContainText('Booked');
  return session.id as string;
}

test('rehearsal is explicit and changing the next mode does not alter the active session', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('radio', { name: /Rehearsal/ })).toBeChecked();
  await page.getByText('Check demo readiness', { exact: true }).click();
  await expect(page.getByText('Local rehearsal appointments', { exact: true })).toBeVisible();
  const created = page.waitForResponse(
    (response) => response.url().endsWith('/api/sessions') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Start in text', exact: true }).click();
  const first = (await (await created).json()).session;
  expect(first.mode).toBe('rehearsal');
  await page.getByRole('radio', { name: /Live/ }).check();
  await expect(page.getByRole('region', { name: 'Demo setup' })).toContainText('Current session: Rehearsal');
  expect((await (await page.request.get(`/api/sessions/${first.id}`)).json()).session.mode).toBe('rehearsal');
  await page.getByRole('button', { name: 'New text session', exact: true }).click();
  await expect(page.locator('.error-banner')).toContainText(
    'Live mode requires a configured Google Calendar',
  );
  const unchanged = (await (await page.request.get(`/api/sessions/${first.id}`)).json()).session;
  expect(unchanged.mode).toBe('rehearsal');
  expect(unchanged.status).toBe('active');
  await expect(page.getByRole('region', { name: 'Demo setup' })).toContainText('Current session: Rehearsal');
});

test('reschedule and cancel keep the persisted appointment unchanged until explicit confirmation', async ({
  page,
}) => {
  const id = await bookRepair(page);
  const initial = (await (await page.request.get(`/api/sessions/${id}/appointments`)).json()).appointments[0];
  const appointment = page.getByRole('region', { name: 'Current appointment' });
  await appointment.getByRole('button', { name: 'Reschedule appointment', exact: true }).click();
  const date = new Date();
  date.setDate(date.getDate() + 3);
  while ([0, 6].includes(date.getDay())) date.setDate(date.getDate() + 1);
  await page.getByLabel('Reschedule date').fill(date.toISOString().slice(0, 10));
  await page.getByRole('button', { name: 'Find replacement times', exact: true }).click();
  await page.getByLabel('Replacement appointment time').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Review reschedule', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Move this appointment?' })).toBeVisible();
  expect(
    (await (await page.request.get(`/api/sessions/${id}/appointments`)).json()).appointments[0].start,
  ).toBe(initial.start);
  await page.getByRole('button', { name: 'Confirm reschedule', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Move this appointment?' })).toHaveCount(0);
  const moved = (await (await page.request.get(`/api/sessions/${id}/appointments`)).json()).appointments[0];
  expect(moved.start).not.toBe(initial.start);
  expect(moved.revision).toBe(initial.revision + 1);
  await appointment.getByRole('button', { name: 'Cancel appointment', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Cancel this appointment?' })).toBeVisible();
  expect(
    (await (await page.request.get(`/api/sessions/${id}/appointments`)).json()).appointments[0].status,
  ).toBe('booked');
  await page.getByRole('button', { name: 'Keep unchanged', exact: true }).click();
  await expect(appointment).toContainText('Booked');
  await appointment.getByRole('button', { name: 'Cancel appointment', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
  await expect(appointment).toContainText('Cancelled');
  expect(
    (await (await page.request.get(`/api/sessions/${id}/appointments`)).json()).appointments[0].status,
  ).toBe('cancelled');
  await page.screenshot({ path: 'test-results/workshop-booking-changes.png', fullPage: true });
});

test('operator quote updates persist and customer approval keeps the AI paused', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Check repair status/ }).click();
  await page.getByRole('button', { name: 'Start in text', exact: true }).click();
  await page.getByRole('button', { name: 'Talk to a person', exact: true }).click();
  await page.getByRole('button', { name: 'Open operator desk', exact: true }).click();
  await page.getByRole('button', { name: 'Accept conversation', exact: true }).click();
  const repair = page.getByRole('region', { name: 'Repair job REP-1042', exact: true });
  await expect(repair).toContainText('Awaiting quote approval');
  await expect(
    page.getByLabel('Next status for REP-1042').locator('option[value="in_progress"]'),
  ).toHaveCount(0);
  await page
    .getByLabel('Repair note for REP-1042')
    .fill('Rechecking the drain pump before finalizing the quote.');
  await repair.getByRole('button', { name: 'Review update', exact: true }).click();
  await repair.getByRole('button', { name: 'Save repair update', exact: true }).click();
  await expect(repair.locator('.status-pill')).toHaveText('In diagnosis');
  await page.getByLabel('Estimate for REP-1042').fill('22500');
  await page
    .getByLabel('Repair note for REP-1042')
    .fill('Pump replacement quoted at 22500 AMD. Customer approval required.');
  await repair.getByRole('button', { name: 'Review update', exact: true }).click();
  await repair.getByRole('button', { name: 'Save repair update', exact: true }).click();
  await page.getByRole('button', { name: 'Demo', exact: true }).click();
  await expect(repair).toContainText('22,500 AMD');
  await repair.getByRole('button', { name: 'Review quote approval', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Approve the repair quote?' })).toContainText('22,500 AMD');
  await expect(repair.locator('.status-pill')).toHaveText('Awaiting quote approval');
  await page.getByRole('button', { name: 'Confirm quote approval', exact: true }).click();
  await expect(repair.locator('.status-pill')).toHaveText('Repair in progress');
  await expect(page.locator('.demo-handoff-banner')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect voice', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Operator desk', exact: true }).click();
  await page
    .getByLabel('Repair note for REP-1042')
    .fill('Replacement installed and tested. Ready for collection.');
  await repair.getByRole('button', { name: 'Review update', exact: true }).click();
  await repair.getByRole('button', { name: 'Save repair update', exact: true }).click();
  await expect(repair.locator('.status-pill')).toHaveText('Ready for collection');
  await page.reload();
  await page.getByRole('button', { name: 'Session history', exact: true }).first().click();
  await page.locator('.history-row').first().click();
  await page.getByRole('button', { name: 'Demo', exact: true }).click();
  await expect(repair.locator('.status-pill')).toHaveText('Ready for collection');
  await repair.getByText('Repair history', { exact: true }).click();
  await expect(repair).toContainText('Customer approved the repair quote');
  await page.screenshot({ path: 'test-results/workshop-repair-progress.png', fullPage: true });
});

test('photo suggestions require review and edits before confirmation (provider boundary stub)', async ({
  page,
}) => {
  const confirmed: Record<string, unknown>[] = [];
  await page.route('**/api/readiness', async (route) => {
    const response = await route.fetch();
    const readiness = await response.json();
    await route.fulfill({ response, json: { ...readiness, vision: { configured: true, provider: 'test' } } });
  });
  await page.route('**/api/sessions/*/photos', (route) =>
    route.fulfill({
      status: 201,
      json: {
        id: 'photo-review-test',
        appliance: 'washing-machine',
        model: 'W10O',
        errorCode: 'E21',
        uncertainties: ['The final model character is unclear.'],
      },
    }),
  );
  await page.route('**/api/sessions/*/photos/photo-review-test/confirm', async (route) => {
    confirmed.push(route.request().postDataJSON());
    await route.fulfill({ json: { details: confirmed.at(-1) } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start in text', exact: true }).click();
  await page.getByText('Add a label or error-code photo', { exact: true }).click();
  await page.getByLabel('Appliance photo').setInputFiles({
    name: 'label.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lxoAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await page.getByRole('button', { name: 'Read photo', exact: true }).click();
  await expect(page.getByText('The final model character is unclear.', { exact: true })).toBeVisible();
  expect(confirmed).toEqual([]);
  const save = page.getByRole('button', { name: 'Use reviewed details', exact: true });
  await expect(save).toBeDisabled();
  const review = page.getByLabel('I checked these details against the label or display.');
  await review.check();
  await page.getByLabel('Model', { exact: true }).fill('W100');
  await expect(review).not.toBeChecked();
  await expect(save).toBeDisabled();
  await review.check();
  await save.click();
  await expect(page.getByText('Reviewed details saved to this session.', { exact: true })).toBeVisible();
  expect(confirmed).toEqual([{ appliance: 'washing-machine', model: 'W100', errorCode: 'E21' }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/workshop-photo-review-mobile.png', fullPage: true });
});
