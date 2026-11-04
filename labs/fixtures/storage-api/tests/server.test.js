'use strict';
// Fixture tests run with `npm test` and need no network: storage is a local fake.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { signBlob, signS3 } = require('../storage');

const SERVER = path.join(__dirname, '..', 'server.js');

function fakeStorage({ missing = false } = {}) {
  const objects = new Map();
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers });
      if (missing) {
        res.writeHead(404, { 'content-type': 'application/xml' });
        res.end('<?xml version="1.0"?><Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message></Error>');
      } else if (req.method === 'PUT') {
        objects.set(req.url, body);
        res.writeHead(200);
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(objects.get(req.url) ?? '');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

function start(env) {
  const port = 40000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, APP_PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return { child, port, output: () => output };
}

async function listeningPort(app) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const match = /listening on port (\d+)/.exec(app.output());
    if (match) {
      return Number(match[1]);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not start: ${app.output()}`);
}

const s3Env = (port) => ({
  STORAGE_PROVIDER: 'aws-s3', STORAGE_NAMESPACE: 'lab-reports', STORAGE_ENDPOINT: `http://127.0.0.1:${port}`,
  AWS_ACCESS_KEY_ID: 'testing', AWS_SECRET_ACCESS_KEY: 'testing', AWS_REGION: 'us-east-1',
});

test('round-trips a payload through the configured S3 target with signed requests', async () => {
  const storage = await fakeStorage();
  const app = start(s3Env(storage.port));
  try {
    const port = await listeningPort(app);
    const response = await fetch(`http://127.0.0.1:${port}/storage-check`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.observedSha256, body.expectedSha256);
    assert.equal(body.key, 'storage-check.txt');
    assert.deepEqual(storage.requests.map((item) => `${item.method} ${item.url}`), ['PUT /lab-reports/storage-check.txt', 'GET /lab-reports/storage-check.txt']);
    assert.match(storage.requests[0].headers.authorization, /^AWS4-HMAC-SHA256 Credential=testing\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.match(app.output(), /Storage target: aws-s3 bucket lab-reports at http:\/\/127\.0\.0\.1:\d+/);
    assert.match(app.output(), /Storage check passed: wrote and read back s3:\/\/lab-reports\/storage-check\.txt/);
  } finally {
    app.child.kill('SIGTERM');
    storage.server.close();
  }
});

test('reports the provider error when the namespace is missing', async () => {
  const storage = await fakeStorage({ missing: true });
  const app = start(s3Env(storage.port));
  try {
    const port = await listeningPort(app);
    const response = await fetch(`http://127.0.0.1:${port}/storage-check`);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'NoSuchBucket: The specified bucket does not exist');
    assert.match(app.output(), /Storage check failed for s3:\/\/lab-reports\/storage-check\.txt: NoSuchBucket/);
  } finally {
    app.child.kill('SIGTERM');
    storage.server.close();
  }
});

test('serves health without storage configuration and hides the check', async () => {
  const app = start({});
  try {
    const port = await listeningPort(app);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/storage-check`)).status, 404);
  } finally {
    app.child.kill('SIGTERM');
  }
});

test('round-trips a payload through the configured Blob target with Shared Key requests', async () => {
  const storage = await fakeStorage();
  const app = start({
    STORAGE_PROVIDER: 'azure-blob',
    STORAGE_NAMESPACE: 'lab-reports',
    STORAGE_ENDPOINT: `http://127.0.0.1:${storage.port}/devstoreaccount1`,
    AZURE_STORAGE_ACCOUNT: 'devstoreaccount1',
    AZURE_STORAGE_KEY: Buffer.from('fixture-test-key').toString('base64'),
    AZURE_STORAGE_API_VERSION: '2026-06-06',
  });
  try {
    const port = await listeningPort(app);
    const response = await fetch(`http://127.0.0.1:${port}/storage-check`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.provider, 'azure-blob');
    assert.equal(body.observedSha256, body.expectedSha256);
    assert.deepEqual(storage.requests.map((item) => `${item.method} ${item.url}`), [
      'PUT /devstoreaccount1/lab-reports/storage-check.txt',
      'GET /devstoreaccount1/lab-reports/storage-check.txt',
    ]);
    assert.ok(storage.requests.every((item) => item.headers['x-ms-version'] === '2026-06-06'));
    assert.match(storage.requests[0].headers.authorization, /^SharedKey devstoreaccount1:[A-Za-z0-9+/]+=*$/);
    assert.match(app.output(), /Storage check passed: wrote and read back http:/);
  } finally {
    app.child.kill('SIGTERM');
    storage.server.close();
  }
});

test('signs deterministically for fixed inputs', () => {
  const url = new URL('http://storage:5000/lab-reports/a.txt');
  const now = new Date('2026-11-04T10:00:00Z');
  const first = signS3({ method: 'GET', url, accessKeyId: 'testing', secretAccessKey: 'testing', region: 'us-east-1', now });
  const second = signS3({ method: 'GET', url, accessKeyId: 'testing', secretAccessKey: 'testing', region: 'us-east-1', now });
  assert.deepEqual(first, second);
  assert.equal(first['x-amz-date'], '20261104T100000Z');
  const blob = signBlob({
    method: 'GET',
    url: new URL('http://storage:10000/devstoreaccount1/lab-reports/a.txt'),
    headers: { 'x-ms-date': 'Wed, 04 Nov 2026 10:00:00 GMT', 'x-ms-version': '2025-11-05' },
    account: 'devstoreaccount1',
    accountKey: Buffer.from('fixture-test-key').toString('base64'),
  });
  assert.match(blob, /^SharedKey devstoreaccount1:[A-Za-z0-9+/]+=*$/);
});
