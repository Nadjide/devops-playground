#!/usr/bin/env node
/**
 * Capture README screenshots from the running application.
 *   node scripts/capture-screenshots.mjs demo    needs `npm run preview --workspace @devops-playground/web`
 *   node scripts/capture-screenshots.mjs local   needs `npm run playground:local`
 */
import { chromium } from '@playwright/test';

const mode = process.argv[2] ?? 'demo';
const base = mode === 'local' ? 'http://127.0.0.1:3001' : 'http://127.0.0.1:4173';
const out = (name) => `docs/screenshots/${name}.png`;

const browser = await chromium.launch();
const context = await browser.newContext({ colorScheme: 'dark', deviceScaleFactor: 1 });
const page = await context.newPage();

async function terminal(command) {
  await page.getByTestId('terminal-host').click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

if (mode === 'demo') {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(base);
  await page.getByRole('button', { name: 'Read logs of api' }).click();
  await terminal('docker start api');
  await page.getByRole('list', { name: 'Session containers' }).getByText('healthy', { exact: true }).waitFor({ timeout: 10_000 });
  await terminal('curl http://api:3000/health');
  await page.getByRole('button', { name: 'Probe /version' }).click();
  await page.getByText('Mission complete').waitFor();
  await page.mouse.move(2, 890);
  await page.screenshot({ path: out('demo-mission-complete') });

  await page.getByRole('combobox', { name: 'Mission' }).selectOption('broken-release');
  await page.getByRole('button', { name: 'Start new session' }).click();
  await page.getByRole('tablist', { name: 'Operations panels' }).getByRole('tab', { name: 'Pipeline' }).click();
  await page.getByRole('button', { name: 'Run pipeline (1.1.0)' }).click();
  await page.getByRole('button', { name: 'verify failed' }).first().waitFor({ timeout: 20_000 });
  await page.mouse.move(2, 890);
  await page.screenshot({ path: out('demo-broken-release-pipeline') });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tablist', { name: 'Workbench panels' }).getByRole('tab', { name: 'Mission' }).click();
  await page.mouse.move(2, 890);
  await page.screenshot({ path: out('demo-mobile-mission') });
} else {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(base);
  await page.getByRole('list', { name: 'Session containers' }).waitFor({ timeout: 180_000 });
  if (!(await page.getByRole('heading', { name: 'Recover a broken release' }).isVisible())) {
    await page.getByRole('combobox', { name: 'Mission' }).selectOption('broken-release');
    await page.getByRole('button', { name: 'Start new session' }).click();
    await page.getByRole('heading', { name: 'Recover a broken release' }).waitFor({ timeout: 180_000 });
  }
  await page.getByRole('list', { name: 'Session containers' }).getByText('exited', { exact: true }).waitFor({ timeout: 180_000 });
  await page.getByRole('button', { name: 'Read logs of api' }).click();
  await page.getByRole('tablist', { name: 'Operations panels' }).getByRole('tab', { name: 'Pipeline' }).click();
  await page.getByRole('button', { name: 'Roll back' }).click();
  await page.getByRole('button', { name: 'verify passed' }).waitFor({ timeout: 120_000 });
  await page.getByRole('tablist', { name: 'Observation panels' }).getByRole('tab', { name: 'Monitoring' }).click();
  await page.getByText('MiB').first().waitFor({ timeout: 30_000 });
  await page.mouse.move(2, 890);
  await page.screenshot({ path: out('local-docker-rollback') });
  await page.getByRole('button', { name: /Session/ }).click();
  await page.getByRole('menuitem', { name: /End session/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'End session' }).click();
  await page.getByText('This session has ended').waitFor({ timeout: 60_000 });
}

await browser.close();
console.log(`Captured ${mode} screenshots in docs/screenshots.`);
