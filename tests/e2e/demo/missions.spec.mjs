import { expect, expectNoHorizontalOverflow, test } from './fixtures.mjs';

async function chooseMission(page, labId) {
  await page.getByRole('combobox', { name: 'Mission' }).selectOption(labId);
  await page.getByRole('button', { name: 'Start new session' }).click();
}

const objective = (page, label) => page.getByRole('listitem').filter({ hasText: label });

test('completes M01 through Docker and Monitoring controls with evidence', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const mission = page.getByRole('complementary', { name: 'Mission' });
  await expect(mission.getByText('0/3 objectives satisfied')).toBeVisible();

  await page.getByRole('button', { name: 'Read logs of api' }).click();
  await expect(objective(page, 'Inspect the service logs')).toContainText('Satisfied');
  await page.getByRole('button', { name: 'Start api', exact: true }).click();
  await expect(objective(page, 'Run the API container')).toContainText('Satisfied');
  await expect(objective(page, 'Verify a successful health response')).toContainText('Pending');
  await page.getByRole('button', { name: 'Probe /health' }).click();
  await expect(mission.getByText('Mission complete')).toBeVisible();

  const health = objective(page, 'Verify a successful health response');
  await health.getByText('Evidence').click();
  await expect(health).toContainText('returned 200 with status ok');

  // Later degradation keeps the historical completion.
  await page.getByRole('button', { name: 'Stop api' }).click();
  await expect(objective(page, 'Run the API container')).toContainText('Invalidated');
  await expect(mission.getByText('Mission complete')).toBeVisible();
  await expect(mission).toContainText('The current service state has changed since then.');
});

test('completes M02 by applying the approved port and verifying health', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await chooseMission(page, 'wrong-port');
  await expect(page.getByRole('heading', { name: 'Fix a port configuration' })).toBeVisible();

  await page.getByRole('button', { name: 'Probe /health' }).click();
  await expect(page.getByRole('article', { name: 'Workload availability' })).toContainText('ECONNREFUSED api:3000');

  await page.getByRole('button', { name: 'Inspect api' }).click();
  await expect(page.getByRole('region', { name: 'Inspect result for api' })).toContainText('appPort 3001');
  await expect(objective(page, 'Find the listening port')).toContainText('Satisfied');

  const appPort = page.getByRole('form', { name: 'api configuration' }).getByLabel('appPort');
  await appPort.fill('80');
  await page.getByRole('button', { name: 'Apply configuration' }).click();
  await expect(page.getByRole('alert')).toContainText('appPort must be an integer from 1024 to 65535.');

  await appPort.fill('3000');
  await page.getByRole('button', { name: 'Apply configuration' }).click();
  await expect(objective(page, 'Run the API on the expected probe port 3000')).toContainText('Satisfied');
  await page.getByRole('button', { name: 'Probe /health' }).click();
  await expect(page.getByRole('complementary', { name: 'Mission' }).getByText('Mission complete')).toBeVisible();
});

test('reset clears objectives and reinitializes the fixture', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start api', exact: true }).click();
  await expect(objective(page, 'Run the API container')).toContainText('Satisfied');
  await page.getByRole('button', { name: /Session/ }).click();
  await page.getByRole('menuitem', { name: /Reset session/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset session' }).click();
  await expect(objective(page, 'Run the API container')).toContainText('Pending');
  await expect(page.getByRole('list', { name: 'Session containers' }).getByText('stopped', { exact: true })).toBeVisible();
  await expect(page.getByText(/generation 2/)).toBeVisible();
});

test('completes M01 from the terminal on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const tabs = page.getByRole('tablist', { name: 'Workbench panels' });
  await tabs.getByRole('tab', { name: 'Terminal' }).click();
  for (const command of ['docker logs api', 'docker start api', 'curl http://api:3000/health']) {
    await page.getByTestId('terminal-host').click();
    await page.keyboard.type(command);
    await page.keyboard.press('Enter');
    await expect(page.locator('.xterm-rows')).toContainText(command);
  }
  await expect(page.getByRole('button', { name: /objectives · complete/ })).toBeVisible();
  await tabs.getByRole('tab', { name: 'Mission' }).click();
  await expect(page.getByText('Mission complete')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
