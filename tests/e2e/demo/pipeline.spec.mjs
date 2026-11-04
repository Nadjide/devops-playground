import { expect, expectNoHorizontalOverflow, test } from './fixtures.mjs';

async function openBrokenRelease(page) {
  await page.getByRole('combobox', { name: 'Mission' }).selectOption('broken-release');
  await page.getByRole('button', { name: 'Start new session' }).click();
  await expect(page.getByRole('heading', { name: 'Recover a broken release' })).toBeVisible();
}

test('completes M03: inspect the failed release, roll back, verify version and health', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await openBrokenRelease(page);
  const containers = page.getByRole('list', { name: 'Session containers' });
  await expect(containers.getByText('exited', { exact: true })).toBeVisible();

  await page.getByRole('tablist', { name: 'Operations panels' }).getByRole('tab', { name: 'Pipeline' }).click();
  const stages = page.getByRole('list', { name: 'Pipeline stages' });
  await expect(stages.getByRole('button', { name: 'verify failed' })).toBeVisible();
  await expect(page.getByLabel('verify stage logs')).toContainText('ECONNREFUSED');
  await testInfo.attach('m03-failed-release.png', { body: await page.screenshot(), contentType: 'image/png' });

  await page.getByRole('button', { name: 'Roll back' }).click();
  await expect(stages.getByRole('button', { name: 'verify passed' })).toBeVisible({ timeout: 15_000 });
  await expect(stages.getByRole('button', { name: 'test skipped' })).toBeVisible();
  await expect(page.getByText('Deployed release')).toBeVisible();
  await expect(page.getByRole('article', { name: 'Observed version' })).toContainText('1.0.0');

  await page.getByRole('tablist', { name: 'Operations panels' }).getByRole('tab', { name: 'Docker' }).click();
  await page.getByRole('button', { name: 'Read logs of api' }).click();
  await expect(page.getByRole('complementary', { name: 'Mission' }).getByText('Mission complete')).toBeVisible();
  await testInfo.attach('m03-complete.png', { body: await page.screenshot(), contentType: 'image/png' });
});

test('runs the broken candidate and rolls back from the terminal on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await openBrokenRelease(page);
  const tabs = page.getByRole('tablist', { name: 'Workbench panels' });
  await tabs.getByRole('tab', { name: 'Terminal' }).click();
  const terminal = page.locator('.xterm-rows');
  for (const [command, expected] of [
    ['pipeline run', 'Pipeline for release 1.1.0: failed'],
    ['pipeline rollback', 'Rollback for release 1.0.0: passed'],
  ]) {
    await page.getByTestId('terminal-host').click();
    await page.keyboard.type(command);
    await page.keyboard.press('Enter');
    await expect(terminal).toContainText(expected, { timeout: 15_000 });
  }
  await tabs.getByRole('tab', { name: 'Pipeline' }).click();
  await expect(page.getByRole('list', { name: 'Pipeline stages' }).getByRole('button', { name: 'verify passed' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
