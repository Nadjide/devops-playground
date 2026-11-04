'use strict';
/**
 * Lab fixture workload. It mirrors the original API contract and prints the
 * same lines as the browser simulator. Release behavior comes only from values
 * baked into the approved image at build time (APP_VERSION, STARTUP_MODE).
 */
const http = require('node:http');

const SERVICE_NAME = 'devops-playground';
const version = process.env.APP_VERSION || '1.0.0';
const port = Number(process.env.APP_PORT || 3000);
const startupMode = process.env.STARTUP_MODE || 'ok';
const startedAt = Date.now();

console.log(`> ${SERVICE_NAME}@${version} start`);

if (startupMode === 'require-feature-flags' && !process.env.FEATURE_FLAGS_URL) {
  // Deliberate lab failure: the 1.1.0 candidate needs configuration nobody provides.
  console.error(`Error: FEATURE_FLAGS_URL is required by release ${version} but is not configured`);
  console.error('    at loadConfiguration (/app/src/config.js:14:11)');
  console.error('Startup aborted, exiting with code 1');
  process.exit(1);
}

console.log(`Configuration loaded: APP_PORT=${port}`);

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    send(res, 405, { error: 'Method not allowed' });
  } else if (req.url === '/') {
    send(res, 200, { message: 'DevOps Playground API is running' });
  } else if (req.url === '/health') {
    send(res, 200, {
      status: 'ok',
      service: SERVICE_NAME,
      uptime: (Date.now() - startedAt) / 1000,
      timestamp: new Date().toISOString(),
    });
  } else if (req.url === '/version') {
    send(res, 200, { name: SERVICE_NAME, version, environment: process.env.NODE_ENV || 'production' });
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
