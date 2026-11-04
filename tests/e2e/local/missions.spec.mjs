import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

const ownedContainers = () => spawnSync('docker', ['ps', '-aq', '--filter', 'label=devops-playground.managed=true',
  '--filter', 'label=devops-playground.role=workload'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);

const objective = (page, label) => page.getByRole('listitem').filter({ hasText: label });

test('completes M01 against real Docker through the workbench', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByText('Local Docker')).toBeVisible();
  const containers = page.getByRole('list', { name: 'Session containers' });
  await expect(containers.getByText('stopped', { exact: true })).toBeVisible({ timeout: 150_000 });
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

  await page.getByRole('button', { name: /Session/ }).click();
  await page.getByRole('menuitem', { name: /End session/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'End session' }).click();
  await expect(page.getByText('This session has ended and its resources were removed.')).toBeVisible({ timeout: 60_000 });
  expect(ownedContainers()).toHaveLength(0);
});
