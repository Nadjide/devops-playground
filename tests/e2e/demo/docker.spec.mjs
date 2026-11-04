import { expect, expectNoHorizontalOverflow, test } from './fixtures.mjs';

test('stops, starts, and probes the simulated API through visible controls', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  const containers = page.getByRole('list', { name: 'Session containers' });
  const availability = page.getByRole('article', { name: 'Workload availability' });
  await expect(containers.getByText('stopped', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Probe /health' }).click();
  await expect(availability.getByText('Unavailable')).toBeVisible();
  await expect(availability).toContainText('ECONNREFUSED api:3000');

  await page.getByRole('button', { name: 'Start api', exact: true }).click();
  await expect(containers.getByText('running', { exact: true })).toBeVisible();
  await expect(containers.getByText('healthy', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Probe /health' }).click();
  await expect(availability.getByText('Available', { exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Last health response' })).toContainText('"status": "ok"');
  await page.getByRole('button', { name: 'Probe /version' }).click();
  await expect(page.getByRole('article', { name: 'Observed version' })).toContainText('1.0.0');

  await page.getByRole('button', { name: 'Stop api' }).click();
  await expect(containers.getByText('stopped', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Probe /health' }).click();
  await expect(availability.getByText('Unavailable')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Probe history' }).getByRole('listitem')).toHaveCount(4);
  await expectNoHorizontalOverflow(page);
});

test('operates the simulated API on a phone-sized viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const tabs = page.getByRole('tablist', { name: 'Workbench panels' });
  await tabs.getByRole('tab', { name: 'Docker' }).click();
  await page.getByRole('button', { name: 'Start api', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Session containers' }).getByText('running', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Inspect api' }).click();
  await expect(page.getByRole('region', { name: 'Inspect result for api' })).toContainText('expectedProbePort');
  await expectNoHorizontalOverflow(page);

  await tabs.getByRole('tab', { name: 'Monitoring' }).click();
  await page.getByRole('button', { name: 'Probe /health' }).click();
  await expect(page.getByRole('article', { name: 'Workload availability' }).getByText('Available', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
