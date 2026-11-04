import { spawnSync } from 'node:child_process';
import { endSession, expect, objective, startMission, test } from './helpers.mjs';

const ownedContainers = () => spawnSync('docker', ['ps', '-aq', '--filter', 'label=devops-playground.managed=true',
  '--filter', 'label=devops-playground.role=workload'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);

test('completes M01 against real Docker through the workbench', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startMission(page, 'stopped-container', 'Restore the API');
  await expect(page.getByText('Local Docker', { exact: true })).toBeVisible();
  const containers = page.getByRole('list', { name: 'Session containers' });
  await expect(containers.getByText('stopped', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(containers).toContainText('Docker');
  expect(ownedContainers()).toHaveLength(1);

  await page.getByRole('button', { name: 'Read logs of api' }).click();
  await expect(objective(page, 'Inspect the service logs')).toContainText('Satisfied');
  await page.getByRole('button', { name: 'Start api', exact: true }).click();
  await expect(containers.getByText('running', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Probe /health' }).click();
  const availability = page.getByRole('article', { name: 'Workload availability' });
  await expect(availability.getByText('Available', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(availability).toContainText('Probe');
  await expect(page.getByRole('complementary', { name: 'Mission' }).getByText('Mission complete')).toBeVisible();

  // Reloading reattaches to the controller-owned session instead of creating another.
  await page.reload();
  await expect(page.getByRole('complementary', { name: 'Mission' }).getByText('Mission complete')).toBeVisible({ timeout: 30_000 });
  expect(ownedContainers()).toHaveLength(1);

  await endSession(page);
  expect(ownedContainers()).toHaveLength(0);
});

test('recovers the broken release with a real rollback from the Pipeline panel', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startMission(page, 'broken-release', 'Recover a broken release');
  const containers = page.getByRole('list', { name: 'Session containers' });
  await expect(containers.getByText('exited', { exact: true })).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Read logs of api' }).click();
  await page.getByRole('tablist', { name: 'Operations panels' }).getByRole('tab', { name: 'Pipeline' }).click();
  await expect(page.getByText('Local pipeline')).toBeVisible();
  await page.getByRole('button', { name: 'Roll back' }).click();
  const stages = page.getByRole('list', { name: 'Pipeline stages' });
  await expect(stages.getByRole('button', { name: 'verify passed' })).toBeVisible({ timeout: 120_000 });
  await expect(stages.getByRole('button', { name: 'test skipped' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Observed version' })).toContainText('1.0.0');
  await expect(page.getByRole('complementary', { name: 'Mission' }).getByText('Mission complete')).toBeVisible();

  await endSession(page);
  expect(ownedContainers()).toHaveLength(0);
});
