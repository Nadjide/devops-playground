#!/usr/bin/env node
/**
 * Assert the running playground stack matches its trust boundaries.
 *   node scripts/check-playground-stack.js demo|local
 * Demo: portal only, no runner, no socket mount, loopback binding.
 * Local: runner connected to Docker, runner has no published port and rejects
 * unauthenticated or browser-origin requests.
 */
const { spawnSync } = require('node:child_process');
const http = require('node:http');

const mode = process.argv[2];
const port = Number(process.env.PLAYGROUND_PORT ?? 3001);
const failures = [];

function check(condition, message) {
  console.log(`${condition ? '✔' : '✖'} ${message}`);
  if (!condition) {
    failures.push(message);
  }
}

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', shell: false });
  return result.status === 0 ? result.stdout.trim() : null;
}

function request(path, headers = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers, timeout: 5000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(body);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, body, json, headers: res.headers });
      });
    });
    req.on('error', () => resolve({ status: 0, body: '', json: null, headers: {} }));
    req.on('timeout', () => req.destroy());
  });
}

async function main() {
  if (!['demo', 'local'].includes(mode)) {
    console.error('Usage: node scripts/check-playground-stack.js <demo|local>');
    process.exit(2);
  }
  const health = await request('/health');
  check(health.status === 200 && health.json?.mode === mode, `controller healthy in ${mode} mode`);
  const page = await request('/');
  check(page.body.includes(`content="${mode}"`), 'workbench served with its execution mode');
  check(String(page.headers['content-security-policy'] ?? '').includes("default-src 'self'"), 'content security policy is set');
  const forged = await request('/api/capabilities', { Host: 'evil.example' });
  check(forged.status === 403, 'forged Host header is rejected');
  const foreign = await request('/api/capabilities', { Origin: 'http://evil.example' });
  check(foreign.status === 403, 'foreign Origin is rejected');
  const capabilities = await request('/api/capabilities');

  const control = docker(['inspect', 'devops-playground-control-1', '--format', '{{json .HostConfig.PortBindings}}|{{len .Mounts}}|{{.Config.User}}']);
  const [bindings, mounts, user] = (control ?? '||').split('|');
  check(bindings.includes('"HostIp":"127.0.0.1"'), 'portal binds to 127.0.0.1 only');
  check(mounts === '0' && user === 'node', 'portal mounts nothing and runs as a non-root user');

  const runnerState = docker(['inspect', 'devops-playground-runner-1', '--format', '{{json .HostConfig.PortBindings}}|{{json .NetworkSettings.Ports}}']);
  if (mode === 'demo') {
    check(runnerState === null, 'no runner container exists in Demo mode');
    check(capabilities.json?.runner?.status === 'disabled', 'capabilities report the runner as disabled');
    const create = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/sessions', method: 'POST', headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' } }, (res) => resolve(res.statusCode));
      req.on('error', () => resolve(0));
      req.end('{}');
    });
    check(create === 403, 'mutations without a CSRF token are rejected');
  } else {
    check(capabilities.json?.runner?.status === 'connected', 'runner connected');
    check(capabilities.json?.docker?.available === true, `Docker available (Engine ${capabilities.json?.docker?.serverVersion ?? 'unknown'})`);
    check(runnerState !== null && runnerState.startsWith('{}|') && !runnerState.includes('HostPort'), 'runner publishes no host port');
    const probe = (headers) => docker(['exec', 'devops-playground-control-1', 'node', '-e',
      `fetch('http://runner:4000/v1/health', { headers: ${headers} }).then((r) => console.log(r.status)).catch(() => console.log(0))`]);
    check(probe('{}') === '401', 'runner rejects unauthenticated requests');
    check(probe("{ authorization: 'Bearer ' + process.env.RUNNER_TOKEN, origin: 'http://127.0.0.1:3001' }") === '403', 'runner rejects browser-origin requests');
    const isolated = docker(['run', '--rm', '--network', 'devops-playground_portal', 'node:22-alpine', 'node', '-e',
      "fetch('http://runner:4000/v1/health').then(() => console.log('reachable')).catch(() => console.log('isolated'))"]);
    check(isolated === 'isolated', 'runner is unreachable from the portal network');
  }

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${mode} stack checks passed.`);
}

main();
