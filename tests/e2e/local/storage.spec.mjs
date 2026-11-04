import { spawnSync } from 'node:child_process';
import { endSession, expect, objective, startMission, test } from './helpers.mjs';

const emulators = () => spawnSync('docker', ['ps', '-aq', '--filter', 'label=devops-playground.managed=true',
  '--filter', 'label=devops-playground.role=emulator'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);

async function terminal(page, command) {
  await page.getByTestId('terminal-host').click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

test('completes the S3 provisioning mission against the local Moto emulator', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startMission(page, 'storage-provision', 'Provision storage for a service (AWS S3)');
  await expect(page.getByText('Local Docker', { exact: true })).toBeVisible();
  expect(emulators()).toHaveLength(1);

  await page.getByRole('tablist', { name: 'Operations panels' }).getByRole('tab', { name: 'Cloud' }).click();
  const cloud = page.locator('.cloud-panel');
  const identity = cloud.getByLabel('Storage backend');
  await expect(identity).toContainText('AWS S3');
  await expect(identity).toContainText('Moto');
  await expect(identity).toContainText('Emulator');
  await expect(cloud.getByRole('list', { name: 'Buckets' })).toContainText('shared-audit-logs');

  await terminal(page, 'aws s3 mb s3://lab-reports');
  await expect(page.getByTestId('terminal-host')).toContainText('make_bucket: lab-reports', { timeout: 30_000 });
  await expect(objective(page, 'Create the bucket the reports service is configured for')).toContainText('Satisfied');

  const write = cloud.getByRole('form', { name: 'Write object to lab-reports' });
  await write.getByLabel('Text content').fill('Report stored in Moto');
  await write.getByRole('button', { name: 'Write object' }).click();
  await cloud.getByRole('button', { name: 'Read notes.txt' }).click();
  await expect(cloud.getByRole('region', { name: 'Content of notes.txt' })).toContainText('Report stored in Moto', { timeout: 30_000 });

  await cloud.getByRole('button', { name: 'Run storage check' }).click();
  const check = cloud.getByLabel('Latest storage check');
  await expect(check).toContainText('round trip passed', { timeout: 30_000 });
  await expect(check).toContainText('Probe');
  await expect(page.getByRole('complementary', { name: 'Mission' }).getByText('Mission complete')).toBeVisible();

  await endSession(page);
  expect(emulators()).toHaveLength(0);
});
