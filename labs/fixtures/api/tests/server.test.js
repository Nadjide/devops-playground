'use strict';
// Fixture tests run inside the pipeline test container with `npm test`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');

function start(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, APP_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return { child, output: () => output };
}

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for the fixture.'));
      }
    }, 20);
  });
}

test('serves health and version contracts and shuts down on SIGTERM', async () => {
  const port = 39000 + Math.floor(Math.random() * 1000);
  const run = start({ APP_PORT: String(port), APP_VERSION: '1.0.0' });
  await waitFor(() => run.output().includes(`listening on port ${port}`));
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.status, 'ok');
  assert.equal(health.service, 'devops-playground');
  assert.ok(health.uptime >= 0);
  const version = await (await fetch(`http://127.0.0.1:${port}/version`)).json();
  assert.deepEqual(version, { name: 'devops-playground', version: '1.0.0', environment: 'production' });
  assert.match(run.output(), /Configuration loaded: APP_PORT=\d+/);

  const exit = new Promise((resolve) => run.child.on('exit', resolve));
  run.child.kill('SIGTERM');
  if (process.platform !== 'win32') {
    assert.equal(await exit, 0);
    assert.match(run.output(), /HTTP server closed, exiting with code 0/);
  }
});

test('fails at startup when the release requires missing configuration', async () => {
  const run = start({ APP_VERSION: '1.1.0', STARTUP_MODE: 'require-feature-flags' });
  const code = await new Promise((resolve) => run.child.on('exit', resolve));
  assert.equal(code, 1);
  assert.match(run.output(), /FEATURE_FLAGS_URL is required by release 1\.1\.0/);
});
