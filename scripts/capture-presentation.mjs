#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = path.join(root, 'test-results/presentation');
const screenshots = path.join(root, 'docs/screenshots');
const base = 'http://127.0.0.1:4188';
const chapters = [];
const errors = [];
const pause = (ms = 1800) => new Promise((resolve) => setTimeout(resolve, ms));

// Refuse an existing server: this recorder must never operate someone's local lab.
await new Promise((resolve, reject) => {
  const socket = net.createServer();
  socket.once('error', reject);
  socket.listen(4188, '127.0.0.1', () => socket.close(resolve));
});
await mkdir(raw, { recursive: true });
await mkdir(screenshots, { recursive: true });
const preview = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'),
  'preview', '--host', '127.0.0.1', '--port', '4188', '--strictPort'], {
  cwd: path.join(root, 'apps/web'), stdio: 'ignore', windowsHide: true,
});
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (preview.exitCode !== null) {
      throw new Error('The presentation preview exited before becoming ready. Build the frontend first.');
    }
    try {
      ready = (await fetch(base, { signal: AbortSignal.timeout(500) })).ok;
    } catch { /* The owned preview is still starting. */ }
    if (ready) {
      break;
    }
    await pause(250);
  }
  if (!ready) {
    throw new Error('The presentation preview did not start.');
  }

  browser = await chromium.launch({ slowMo: 140 });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, colorScheme: 'light',
    recordVideo: { dir: raw, size: { width: 1600, height: 1000 } },
  });
  const page = await context.newPage();
  const started = Date.now();
  const chapter = (title) => {
    chapters.push({ title, start: (Date.now() - started) / 1000 });
    console.log(`Recording: ${title}`);
  };
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) {
      errors.push(`Unexpected backend request: ${request.url()}`);
    }
  });
  const terminal = async (command) => {
    await page.getByTestId('terminal-host').click();
    await page.keyboard.type(command, { delay: 42 });
    await page.keyboard.press('Enter');
    await pause(900);
  };
  const tab = async (group, name) => page.getByRole('tablist', { name: group }).getByRole('tab', { name }).click();
  const mission = async (id) => {
    await page.getByRole('combobox', { name: 'Mission' }).selectOption(id);
    await page.getByRole('button', { name: 'Start new session' }).click();
    await pause();
  };
  const shot = async (name) => {
    await page.getByRole('heading', { name: 'DevOps Playground', exact: true }).click();
    await page.mouse.move(1590, 990);
    await page.screenshot({ path: path.join(screenshots, name) });
  };

  chapter('Restore a stopped API');
  await page.goto(base);
  await expect(page.getByRole('banner')).toContainText('Demo mode');
  await pause(2200);
  await page.getByRole('button', { name: 'Read logs of api' }).click();
  await pause();
  await terminal('docker start api');
  await expect(page.getByRole('list', { name: 'Session containers' }).getByText('healthy', { exact: true })).toBeVisible();
  await terminal('curl http://api:3000/health');
  await page.getByRole('button', { name: 'Probe /version' }).click();
  await expect(page.getByText('Mission complete', { exact: true })).toBeVisible();
  await tab('Observation panels', 'Monitoring');
  await pause(2600);
  await shot('demo-mission-complete.png');

  chapter('Test, build, deploy, verify, and roll back');
  await mission('broken-release');
  await page.getByRole('button', { name: 'Read logs of api' }).click();
  await tab('Operations panels', 'Pipeline');
  await page.getByRole('button', { name: 'Run pipeline (1.1.0)' }).click();
  await expect(page.getByRole('list', { name: 'Pipeline stages' }).getByRole('button', { name: 'verify failed' })).toBeVisible({ timeout: 25_000 });
  await pause(2400);
  await shot('demo-broken-release-pipeline.png');
  await page.getByRole('button', { name: 'Roll back' }).click();
  await expect(page.getByRole('list', { name: 'Pipeline stages' }).getByRole('button', { name: 'verify passed' })).toBeVisible({ timeout: 25_000 });
  await pause(2400);
  await shot('demo-pipeline-recovered.png');

  chapter('Provision S3 storage');
  await mission('storage-provision');
  await tab('Operations panels', 'Cloud');
  let cloud = page.locator('.cloud-panel');
  await terminal('aws s3 mb s3://lab-reports');
  let upload = cloud.getByRole('form', { name: 'Write object to lab-reports' });
  await upload.getByLabel('Text content').fill('Deployment report ready');
  await upload.getByRole('button', { name: 'Write object' }).click();
  await terminal('aws s3 cp s3://lab-reports/notes.txt -');
  await cloud.getByRole('button', { name: 'Run storage check' }).click();
  await expect(cloud.getByLabel('Latest storage check')).toContainText('round trip passed');
  await expect(page.getByText('Mission complete', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Probe /health', exact: true }).click();
  await page.getByRole('button', { name: 'Collapse terminal and events' }).click();
  await page.getByRole('heading', { name: 'Cloud storage', exact: true }).scrollIntoViewIfNeeded();
  await pause(2600);
  await shot('demo-s3-storage.png');

  chapter('Provision Azure Blob storage');
  await cloud.getByRole('group', { name: 'Storage provider' }).getByRole('button', { name: 'Azure Blob' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start new session' }).click();
  await expect(page.getByRole('heading', { name: 'Provision storage for a service (Azure Blob)' })).toBeVisible();
  await tab('Operations panels', 'Cloud');
  cloud = page.locator('.cloud-panel');
  const openDrawer = page.getByRole('button', { name: 'Open terminal and events', exact: true });
  if (await openDrawer.isVisible()) {
    await openDrawer.click();
  }
  await terminal('az storage container create -n lab-reports');
  upload = cloud.getByRole('form', { name: 'Write blob to lab-reports' });
  await upload.getByLabel('Text content').fill('Release evidence stored in a blob');
  await upload.getByRole('button', { name: 'Write blob' }).click();
  await terminal('az storage blob download -c lab-reports -n notes.txt');
  await terminal('curl http://api:3000/storage-check');
  await expect(page.getByText('Mission complete', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Probe /health', exact: true }).click();
  await page.getByRole('button', { name: 'Collapse terminal and events' }).click();
  await page.getByRole('heading', { name: 'Cloud storage', exact: true }).scrollIntoViewIfNeeded();
  await pause(3500);
  await shot('demo-azure-storage.png');

  const video = page.video();
  await context.close();
  const videoPath = await video.path();
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true });
  const phone = await mobile.newPage();
  await phone.goto(base);
  await phone.getByRole('combobox', { name: 'Mission' }).selectOption('blob-provision');
  await phone.getByRole('button', { name: 'Start new session' }).click();
  await phone.getByRole('tablist', { name: 'Workbench panels' }).getByRole('tab', { name: 'Cloud' }).click();
  await expect(phone.getByLabel('Storage backend')).toContainText('Azure Blob');
  const mobileCloud = phone.locator('.cloud-panel');
  await mobileCloud.getByLabel('New container').fill('lab-reports');
  await mobileCloud.getByRole('button', { name: 'Create container', exact: true }).click();
  await mobileCloud.getByLabel('Text content').fill('Release evidence stored in a blob');
  await mobileCloud.getByRole('button', { name: 'Write blob', exact: true }).click();
  await mobileCloud.getByRole('button', { name: 'Read notes.txt', exact: true }).click();
  await mobileCloud.getByRole('button', { name: 'Run storage check', exact: true }).click();
  await expect(mobileCloud.getByLabel('Latest storage check')).toContainText('round trip passed');
  await phone.getByRole('heading', { name: 'Cloud storage', exact: true }).scrollIntoViewIfNeeded();
  expect(await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await phone.screenshot({ path: path.join(screenshots, 'demo-mobile-cloud.png'), fullPage: true });
  await mobile.close();
  expect(errors).toEqual([]);
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout.trim();
  await writeFile(path.join(raw, 'capture.json'), JSON.stringify({ video: videoPath, commit, chapters, mode: 'demo', backendRequests: 0, viewport: { width: 1600, height: 1000 } }, null, 2));
  console.log(`Presentation captured from ${commit}. No backend requests or browser errors. ${videoPath}`);
} finally {
  await browser?.close();
  preview.kill();
}
