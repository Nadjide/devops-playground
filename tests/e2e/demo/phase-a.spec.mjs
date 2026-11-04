import { expect, expectNoHorizontalOverflow, test } from './fixtures.mjs';

const objective = (page, label) => page.getByRole('listitem').filter({ hasText: label });

test('restores progress after reload, completes the mission, then resets', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Read logs of api' }).click();
  await page.getByRole('button', { name: 'Start api', exact: true }).click();
  await expect(objective(page, 'Run the API container')).toContainText('Satisfied');
  await expect(page.getByText('Progress saved locally')).toBeVisible();

  await page.reload();
  await expect(page.getByText(/Restored your saved demo session/)).toBeVisible();
  await expect(objective(page, 'Inspect the service logs')).toContainText('Satisfied');
  await expect(page.getByRole('list', { name: 'Session containers' }).getByText('running', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Probe /health' }).click();
  await expect(page.getByRole('complementary', { name: 'Mission' }).getByText('Mission complete')).toBeVisible();

  await page.getByRole('button', { name: /Session/ }).click();
  await page.getByRole('menuitem', { name: /Reset session/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset session' }).click();
  await expect(objective(page, 'Run the API container')).toContainText('Pending');
  await page.reload();
  await expect(page.getByText(/generation 2/).first()).toBeVisible();
});

test('reloads during a pipeline run and reconciles it as cancelled', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Mission' }).selectOption('free-exploration');
  await page.getByRole('button', { name: 'Start new session' }).click();
  await page.getByRole('tablist', { name: 'Operations panels' }).getByRole('tab', { name: 'Pipeline' }).click();
  await page.getByRole('button', { name: /Run pipeline/ }).click();
  await expect(page.getByRole('button', { name: 'test running' })).toBeVisible();
  await page.waitForTimeout(400);
  await page.reload();
  await page.getByRole('tablist', { name: 'Operations panels' }).getByRole('tab', { name: 'Pipeline' }).click();
  await expect(page.getByRole('list', { name: 'Pipeline stages' }).getByRole('button', { name: /cancelled/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Run pipeline/ })).not.toHaveAttribute('aria-disabled');
});

test('offers recovery for corrupt saved progress', async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('devops-playground:demo-checkpoint:v1', '{"checkpointVersion":1,"session":');
      sessionStorage.setItem('seeded', '1');
    }
  });
  await page.goto('/');
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Saved progress could not be restored');
  await expect(page.getByText('Saving paused')).toBeVisible();
  await alert.getByRole('button', { name: 'Discard saved progress' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('Progress saved locally')).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Restored your saved demo session/)).toBeVisible();
});

test('keeps working when browser storage rejects writes', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start api', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Session containers' }).getByText('running', { exact: true })).toBeVisible();
  await expect(page.getByText('Progress not saved')).toBeVisible();
});

test('completes M01 with the keyboard only', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const press = async (name) => {
    const target = page.getByRole('button', { name, exact: true });
    for (let step = 0; step < 80 && !(await target.evaluate((node) => node === document.activeElement)); step += 1) {
      await page.keyboard.press('Tab');
    }
    await expect(target).toBeFocused();
    await page.keyboard.press('Enter');
  };
  await press('Read logs of api');
  await press('Start api');
  await expect(objective(page, 'Run the API container')).toContainText('Satisfied');
  await press('Probe /health');
  await expect(page.getByRole('complementary', { name: 'Mission' }).getByText('Mission complete')).toBeVisible();
});

test('completes M02 through controls on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Mission' }).selectOption('wrong-port');
  await page.getByRole('button', { name: 'Start new session' }).click();
  const tabs = page.getByRole('tablist', { name: 'Workbench panels' });
  await tabs.getByRole('tab', { name: 'Docker' }).click();
  await page.getByRole('button', { name: 'Inspect api' }).click();
  await page.getByRole('form', { name: 'api configuration' }).getByLabel('appPort').fill('3000');
  await page.getByRole('button', { name: 'Apply configuration' }).click();
  // The running wrong-port container is replaced: wait for the configuration operation itself.
  await expect(page.getByRole('region', { name: 'Recent container operations' }).getByRole('listitem')
    .filter({ hasText: 'Apply configuration api' }).first()).toContainText('succeeded');
  await expectNoHorizontalOverflow(page);
  await tabs.getByRole('tab', { name: 'Monitoring' }).click();
  await page.getByRole('button', { name: 'Probe /health' }).click();
  await expect(page.getByRole('button', { name: /objectives · complete/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
