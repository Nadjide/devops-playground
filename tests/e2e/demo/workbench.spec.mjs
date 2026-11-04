import { expect, expectNoHorizontalOverflow, test, viewports } from './fixtures.mjs';

for (const viewport of viewports) {
  test(`renders the workbench without overflow at ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1, name: 'DevOps Playground' })).toBeVisible();
    await expect(page.getByText('Demo mode')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Simulator ready' })).toBeVisible();
    await expect(page.getByRole('combobox')).toHaveValue('stopped-container');

    if (viewport.layout === 'desktop') {
      await expect(page.getByRole('complementary', { name: 'Mission' })).toBeVisible();
      await expect(page.getByRole('tablist', { name: 'Operations panels' })).toBeVisible();
      await expect(page.getByRole('tablist', { name: 'Observation panels' })).toBeVisible();
    } else {
      const tabs = page.getByRole('tablist', { name: 'Workbench panels' });
      await expect(tabs.getByRole('tab', { name: 'Mission' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('heading', { name: 'Restore the API', level: 2 })).toBeVisible();
    }

    await expectNoHorizontalOverflow(page);
    await testInfo.attach(`${viewport.name}.png`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  });
}

test('switches desktop panels and resizes them with the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  const operations = page.getByRole('tablist', { name: 'Operations panels' });
  await operations.getByRole('tab', { name: 'Docker' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(operations.getByRole('tab', { name: 'Pipeline' })).toHaveAttribute('aria-selected', 'true');
  await expect(operations.getByRole('tab', { name: 'Pipeline' })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Delivery pipeline' })).toBeVisible();

  const separator = page.getByRole('separator', { name: 'Resize operations and observation panels' });
  const before = Number(await separator.getAttribute('aria-valuenow'));
  await separator.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => Number(await separator.getAttribute('aria-valuenow'))).toBeLessThan(before);

  await page.keyboard.press('Control+Backquote');
  await expect(page.getByRole('button', { name: 'Open terminal and events' })).toBeVisible();
  await page.getByRole('tab', { name: 'Events' }).click();
  await expect(page.getByRole('list', { name: 'Orchestration events' })).toContainText('session.status-changed');
});

test('keeps every panel reachable on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const tabs = page.getByRole('tablist', { name: 'Workbench panels' });
  for (const [tab, heading] of [
    ['Docker', 'Docker containers'], ['Monitoring', 'Workload monitoring'], ['Logs', 'Workload logs'],
    ['Terminal', 'Command terminal'], ['Pipeline', 'Delivery pipeline'], ['Events', 'Orchestration events'],
  ]) {
    await tabs.getByRole('tab', { name: tab }).click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});
