'use strict';
/**
 * Storage-capable lab workload. It keeps the fixture API contract (/health,
 * /version) and adds /storage-check: write a fresh payload through the
 * configured storage target, read it back, and compare SHA-256 digests.
 * The target comes from the environment the runner sets on the container.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { createStorageClient, sha256 } = require('./storage');

const SERVICE_NAME = 'devops-playground';
const CHECK_KEY = 'storage-check.txt';
const version = process.env.APP_VERSION || '1.0.0';
const port = Number(process.env.APP_PORT || 3000);
const provider = process.env.STORAGE_PROVIDER || '';
const namespace = process.env.STORAGE_NAMESPACE || '';
const endpoint = process.env.STORAGE_ENDPOINT || '';
const startedAt = Date.now();
const term = provider === 'azure-blob' ? 'container' : 'bucket';
const client = createStorageClient(process.env);

console.log(`> ${SERVICE_NAME}@${version} start`);
console.log(`Configuration loaded: APP_PORT=${port}`);
if (client) {
  console.log(`Storage target: ${provider} ${term} ${namespace} at ${endpoint}`);
}

const uriOf = (key) => (provider === 'aws-s3' ? `s3://${namespace}/${key}` : `${endpoint}/${namespace}/${key}`);

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function describe(error) {
  const cause = error.cause;
  if (cause?.code) {
    return `${cause.code === 'ECONNREFUSED' ? 'connect ECONNREFUSED' : cause.code} ${new URL(endpoint).host}`;
  }
  if (error.name === 'TimeoutError') {
    return `request to ${new URL(endpoint).host} timed out`;
  }
  return error.message;
}

async function storageCheck() {
  const payload = `devops-playground storage check\nprovider=${provider}\nnamespace=${namespace}\nnonce=${crypto.randomUUID()}\n`;
  const expectedSha256 = sha256(payload);
  const started = Date.now();
  const result = {
    provider, endpoint, namespace, key: CHECK_KEY, bytes: Buffer.byteLength(payload), expectedSha256, observedSha256: null,
  };
  try {
    await client.put(namespace, CHECK_KEY, payload);
    const read = await client.get(namespace, CHECK_KEY);
    const observedSha256 = sha256(read);
    const ok = observedSha256 === expectedSha256;
    if (ok) {
      console.log(`Storage check passed: wrote and read back ${uriOf(CHECK_KEY)} (sha256 ${observedSha256.slice(0, 12)})`);
    } else {
      console.error(`Storage check failed for ${uriOf(CHECK_KEY)}: payload digest mismatch`);
    }
    return { status: ok ? 200 : 503, body: { ok, ...result, observedSha256, error: ok ? null : 'payload digest mismatch', durationMs: Date.now() - started } };
  } catch (error) {
    const message = describe(error);
    console.error(`Storage check failed for ${uriOf(CHECK_KEY)}: ${message}`);
    return { status: 503, body: { ok: false, ...result, error: message, durationMs: Date.now() - started } };
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    send(res, 405, { error: 'Method not allowed' });
  } else if (req.url === '/') {
    send(res, 200, { message: 'DevOps Playground API is running' });
  } else if (req.url === '/health') {
    send(res, 200, { status: 'ok', service: SERVICE_NAME, uptime: (Date.now() - startedAt) / 1000, timestamp: new Date().toISOString() });
  } else if (req.url === '/version') {
    send(res, 200, { name: SERVICE_NAME, version, environment: process.env.NODE_ENV || 'production' });
  } else if (req.url === '/storage-check' && client) {
    storageCheck().then(({ status, body }) => send(res, status, body), () => send(res, 500, { ok: false, error: 'storage check crashed' }));
  } else {
    send(res, 404, { error: 'Not found' });
  }
});

server.listen(port, () => {
  console.log(`DevOps Playground API ${version} listening on port ${port}`);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed, exiting with code 0');
    process.exit(0);
  });
});
