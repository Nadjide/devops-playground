import { spawnSync } from 'node:child_process';
import { endSession, expect, objective, startMission, test } from './helpers.mjs';

const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });

test('completes M02 against real Docker with the configuration form', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startMission(page, 'wrong-port', 'Fix a port configuration');
  const containers = page.getByRole('list', { name: 'Session containers' });
  await expect(containers.getByText('running', { exact: true })).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Probe /health' }).click();
  await expect(page.getByRole('article', { name: 'Workload availability' })).toContainText('ECONNREFUSED', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Inspect api' }).click();
  await expect(objective(page, 'Find the listening port')).toContainText('Satisfied');
  await page.getByRole('form', { name: 'api configuration' }).getByLabel('appPort').fill('3000');
  await page.getByRole('button', { name: 'Apply configuration' }).click();
  await expect(objective(page, 'Run the API on the expected probe port 3000')).toContainText('Satisfied', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Probe /health' }).click();
  await expect(page.getByRole('complementary', { name: 'Mission' }).getByText('Mission complete')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('region', { name: 'Measured resource usage' })).toContainText('MiB', { timeout: 20_000 });
  await endSession(page);
});

test('reports a stopped runner as a failed operation and recovers after restart', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startMission(page, 'stopped-container', 'Restore the API');
  await expect(page.getByRole('list', { name: 'Session containers' })).toBeVisible({ timeout: 150_000 });
  docker('stop', 'devops-playground-runner-1');
  try {
    await page.getByRole('button', { name: 'Inspect api' }).click();
    const recent = page.getByRole('region', { name: 'Recent container operations' });
    await expect(recent).toContainText('runner is not reachable', { timeout: 30_000 });
    await expect(page.getByText('Local Docker')).toBeVisible();
  } finally {
    docker('start', 'devops-playground-runner-1');
  }
  await expect.poll(() => docker('inspect', 'devops-playground-runner-1', '--format', '{{.State.Health.Status}}').stdout.trim(),
    { timeout: 60_000 }).toBe('healthy');
  await page.getByRole('button', { name: 'Start api', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Session containers' }).getByText('running', { exact: true })).toBeVisible({ timeout: 30_000 });
  await endSession(page);
});

test('keeps the local workbench usable on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startMission(page, 'stopped-container', 'Restore the API');
  await page.setViewportSize({ width: 390, height: 844 });
  const tabs = page.getByRole('tablist', { name: 'Workbench panels' });
  await tabs.getByRole('tab', { name: 'Terminal' }).click();
  for (const command of ['docker start api', 'curl http://api:3000/health']) {
    await page.getByTestId('terminal-host').click();
    await page.keyboard.type(command);
    await page.keyboard.press('Enter');
  }
  await expect(page.locator('.xterm-rows')).toContainText('"status":"ok"', { timeout: 30_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await tabs.getByRole('tab', { name: 'Mission' }).click();
  await expect(page.getByRole('heading', { name: 'Restore the API' })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await endSession(page);
});
