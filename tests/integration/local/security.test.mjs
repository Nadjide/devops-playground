// Security regression suite against the packaged Local Docker stack.
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowser, docker, endIfOpen, launcher, PORT } from './client.mjs';

function raw(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: { Host: `127.0.0.1:${PORT}`, ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

describe('local security boundaries', { timeout: 10 * 60_000 }, () => {
  let browser;
  let session;
  const responses = [];

  before(async () => {
    launcher('down');
    launcher('local');
    browser = await createBrowser().connect();
    session = await browser.createSession('stopped-container');
  });

  after(async () => {
    await endIfOpen(browser, session.id);
    launcher('down');
  });

  it('rejects forged hosts, foreign origins, cross-site fetches, and missing CSRF tokens', async () => {
    assert.equal((await raw('GET', '/api/capabilities', { headers: { Host: 'attacker.example' } })).status, 403);
    assert.equal((await raw('GET', '/api/capabilities', { headers: { Origin: 'http://attacker.example' } })).status, 403);
    assert.equal((await raw('GET', '/api/capabilities', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    const noCsrf = await raw('POST', '/api/sessions', {
      headers: { Origin: `http://127.0.0.1:${PORT}`, 'Content-Type': 'application/json' }, body: '{"labId":"wrong-port"}',
    });
    assert.equal(noCsrf.status, 403);
    const allowed = await raw('GET', '/api/capabilities');
    assert.equal(allowed.headers['access-control-allow-origin'], undefined);
    assert.match(allowed.headers['content-security-policy'], /frame-ancestors 'none'/);
  });

  it('hides the session from another browser on every route', async () => {
    const other = await createBrowser().connect();
    for (const path of [`/api/sessions/${session.id}`, `/api/sessions/${session.id}/events`, `/api/sessions/${session.id}/metrics`]) {
      assert.equal((await other.request('GET', path)).status, 404, path);
    }
    const mutation = await other.request('POST', `/api/sessions/${session.id}/operations`, {
      body: { type: 'container.stop', generation: 1, parameters: { serviceId: 'api' } }, key: 'foreign-stop',
    });
    assert.equal(mutation.status, 404);
  });

  it('refuses arbitrary commands, images, ports, URLs, and oversized bodies', async () => {
    const attempts = [
      { type: 'container.exec', generation: 1, parameters: { serviceId: 'api', command: 'sh -c id' } },
      { type: 'health.probe', generation: 1, parameters: { serviceId: 'api', url: 'http://169.254.169.254/latest/meta-data' } },
      { type: 'health.probe', generation: 1, parameters: { serviceId: 'api', port: 22 } },
      { type: 'service.configure', generation: 1, parameters: { serviceId: 'api', appPort: 3000, image: 'alpine:latest' } },
      { type: 'service.configure', generation: 1, parameters: { serviceId: 'api', appPort: 80 } },
      { type: 'pipeline.run', generation: 1, parameters: { releaseId: 'api-1-0-1', buildArgs: { X: '1' } } },
      { type: 'container.start', generation: 1, parameters: { serviceId: '../../etc' } },
    ];
    for (const [index, body] of attempts.entries()) {
      const response = await browser.request('POST', `/api/sessions/${session.id}/operations`, { body, key: `attack-${index}` });
      assert.equal(response.status, 400, JSON.stringify(body));
      responses.push(JSON.stringify(response.body));
    }
    const unknown = await browser.request('POST', `/api/sessions/${session.id}/operations`, {
      body: { type: 'container.start', generation: 1, parameters: { serviceId: 'db' } }, key: 'attack-db',
    });
    assert.equal(unknown.status, 404);
    const oversized = await browser.request('POST', '/api/sessions', { body: { labId: 'x'.repeat(70 * 1024) } });
    assert.equal(oversized.status, 413);
    assert.equal((await browser.session(session.id)).operations.length, 0, 'no rejected request reached the runtime');
  });

  it('never exposes the runner token or a published runner port', async () => {
    const token = docker('exec', 'devops-playground-runner-1', 'printenv', 'RUNNER_TOKEN');
    assert.ok(token.length >= 32);
    for (const path of ['/api/capabilities', '/api/sessions', `/api/sessions/${session.id}`]) {
      responses.push(JSON.stringify((await browser.request('GET', path)).body));
    }
    responses.push((await raw('GET', '/')).text);
    assert.ok(responses.every((text) => !text.includes(token)), 'token absent from every response');
    assert.equal(docker('inspect', 'devops-playground-runner-1', '--format', '{{len .HostConfig.PortBindings}}'), '0');
    assert.ok(!docker('logs', 'devops-playground-control-1').includes(token));
  });
});
