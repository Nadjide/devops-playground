import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createBrowser, createTestApp, fakeRunner, HOST, ORIGIN } from './helpers.js';

async function createSession(browser, labId = 'stopped-container') {
  const response = await browser.post('/api/sessions', { labId });
  expect(response.status).toBe(201);
  return response.body.session;
}

describe('host and origin protection', () => {
  it('rejects forged Host headers but serves management health', async () => {
    const { app } = createTestApp();
    const rejected = await request(app).get('/api/capabilities').set('Host', 'evil.example');
    expect(rejected.status).toBe(403);
    expect(rejected.body.error.code).toBe('HOST_REJECTED');
    const health = await request(app).get('/health').set('Host', 'anything:9');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: 'ok', service: 'devops-playground-control', mode: 'local' });
  });

  it.each([
    [{}, 'missing Origin on a mutation'],
    [{ Origin: 'http://evil.example' }, 'foreign Origin'],
    [{ Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' }, 'cross-site fetch'],
  ])('rejects %j (%s)', async (headers) => {
    const { app } = createTestApp();
    const browser = await createBrowser(app);
    let req = browser.agent.post('/api/sessions').set('Host', HOST).set('X-CSRF-Token', browser.token);
    for (const [name, value] of Object.entries(headers)) {
      req = req.set(name, value);
    }
    const response = await req.send({ labId: 'stopped-container' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ORIGIN_REJECTED');
  });

  it('refuses foreign-origin reads and never emits CORS headers', async () => {
    const { app } = createTestApp();
    const response = await request(app).get('/api/capabilities').set('Host', HOST).set('Origin', 'http://evil.example');
    expect(response.status).toBe(403);
    const allowed = await request(app).get('/api/capabilities').set('Host', HOST).set('Origin', ORIGIN);
    expect(allowed.headers['access-control-allow-origin']).toBeUndefined();
    expect(allowed.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});

describe('browser sessions and CSRF', () => {
  it('issues an HttpOnly SameSite=Strict session cookie and a bound token', async () => {
    const { app } = createTestApp();
    const browser = await createBrowser(app);
    expect(browser.cookie[0]).toMatch(/^pg_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict$/);
    expect(browser.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('rejects mutations without a token or with another browser token', async () => {
    const { app } = createTestApp();
    const first = await createBrowser(app);
    const second = await createBrowser(app);
    expect((await first.post('/api/sessions', { labId: 'stopped-container' }, { csrf: '' })).body.error.code).toBe('CSRF_REJECTED');
    expect((await first.post('/api/sessions', { labId: 'stopped-container' }, { csrf: second.token })).status).toBe(403);
  });

  it('hides sessions from other browsers on reads and mutations', async () => {
    const { app } = createTestApp();
    const owner = await createBrowser(app);
    const other = await createBrowser(app);
    const session = await createSession(owner);
    expect((await owner.get(`/api/sessions/${session.id}`)).status).toBe(200);
    expect((await other.get(`/api/sessions/${session.id}`)).body.error.code).toBe('SESSION_NOT_FOUND');
    const mutation = await other.post(`/api/sessions/${session.id}/operations`,
      { type: 'container.start', generation: 1, parameters: { serviceId: 'api' } }, { key: 'k1' });
    expect(mutation.status).toBe(404);
    expect((await other.get(`/api/sessions/${session.id}/events`)).status).toBe(404);
  });

  it('allows one active local session', async () => {
    const { app } = createTestApp();
    const browser = await createBrowser(app);
    await createSession(browser);
    const second = await browser.post('/api/sessions', { labId: 'wrong-port' });
    expect(second.status).toBe(429);
    expect(second.body.error).toMatchObject({ code: 'CAPACITY_EXCEEDED', retryable: true });
  });
});

describe('operation endpoint', () => {
  it('accepts typed operations with 202 and honours idempotency keys', async () => {
    const { app, clock } = createTestApp();
    const browser = await createBrowser(app);
    const session = await createSession(browser);
    const body = { type: 'container.start', generation: 1, parameters: { serviceId: 'api' } };
    const first = await browser.post(`/api/sessions/${session.id}/operations`, body, { key: 'start-1' });
    expect(first.status).toBe(202);
    expect(first.body.operation).toMatchObject({ type: 'container.start', status: 'queued' });
    const retry = await browser.post(`/api/sessions/${session.id}/operations`, body, { key: 'start-1' });
    expect(retry.body.operation.id).toBe(first.body.operation.id);
    const conflict = await browser.post(`/api/sessions/${session.id}/operations`,
      { ...body, type: 'container.stop' }, { key: 'start-1' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', operationId: first.body.operation.id });

    await clock.runAll();
    const status = await browser.get(`/api/sessions/${session.id}/operations/${first.body.operation.id}`);
    expect(status.body.operation).toMatchObject({ status: 'succeeded' });
    expect((await browser.get(`/api/sessions/${session.id}`)).body.session.resources[0].observed).toMatchObject({ state: 'running', source: 'docker' });
  });

  it.each([
    [{ type: 'container.exec', generation: 1, parameters: { command: 'sh' } }, 400, 'INVALID_OPERATION'],
    [{ type: 'service.configure', generation: 1, parameters: { serviceId: 'api', appPort: 3000 } }, 422, 'OPERATION_NOT_ALLOWED'],
    [{ type: 'container.start', generation: 1, parameters: { serviceId: 'db' } }, 404, 'UNKNOWN_SERVICE'],
    [{ type: 'container.start', generation: 7, parameters: { serviceId: 'api' } }, 409, 'STALE_GENERATION'],
  ])('maps rejected operation %# to HTTP %i', async (body, status, code) => {
    const { app } = createTestApp();
    const browser = await createBrowser(app);
    const session = await createSession(browser);
    const response = await browser.post(`/api/sessions/${session.id}/operations`, body, { key: 'k' });
    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
  });

  it('requires an idempotency key and enforces queue capacity', async () => {
    const { app } = createTestApp();
    const browser = await createBrowser(app);
    const session = await createSession(browser);
    const body = { type: 'container.restart', generation: 1, parameters: { serviceId: 'api' } };
    expect((await browser.post(`/api/sessions/${session.id}/operations`, body)).body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
    for (let index = 0; index < 10; index += 1) {
      expect((await browser.post(`/api/sessions/${session.id}/operations`, body, { key: `r-${index}` })).status).toBe(202);
    }
    const full = await browser.post(`/api/sessions/${session.id}/operations`, body, { key: 'r-overflow' });
    expect(full.status).toBe(429);
    expect(full.body.error.code).toBe('CAPACITY_EXCEEDED');
  });

  it('bounds and validates request bodies', async () => {
    const { app } = createTestApp();
    const browser = await createBrowser(app);
    const large = await browser.post('/api/sessions', { labId: 'x'.repeat(70 * 1024) });
    expect(large.status).toBe(413);
    const malformed = await browser.agent.post('/api/sessions').set('Host', HOST).set('Origin', ORIGIN)
      .set('X-CSRF-Token', browser.token).set('Content-Type', 'application/json').send('{"labId":');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('MALFORMED_JSON');
    expect((await browser.post('/api/sessions', { labId: '../../etc' })).body.error.code).toBe('INVALID_REQUEST');
  });

  it('returns a safe 500 with a correlation ID for unexpected failures', async () => {
    const logged = [];
    const store = { create: async () => { throw new Error('secret token abc123 leaked'); }, get: () => null };
    const { app } = createTestApp({ store, logger: { error: (message) => logged.push(message) } });
    const browser = await createBrowser(app);
    const response = await browser.post('/api/sessions', { labId: 'stopped-container' });
    expect(response.status).toBe(500);
    expect(response.body.error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'The control service failed unexpectedly.' });
    expect(JSON.stringify(response.body)).not.toContain('abc123');
    expect(logged[0]).toContain(response.body.error.details.correlationId);
  });
});

describe('capabilities and modes', () => {
  it('reports runner and Docker diagnostics without falling back to simulation', async () => {
    const { app } = createTestApp({ runner: fakeRunner({ healthy: false }) });
    const browser = await createBrowser(app);
    const response = await browser.get('/api/capabilities');
    expect(response.body).toMatchObject({ mode: 'local', runner: { status: 'unavailable', error: { code: 'RUNNER_UNAVAILABLE' } }, labs: [] });
    const create = await browser.post('/api/sessions', { labId: 'stopped-container' });
    expect(create.status).toBe(503);
    expect(create.body.error).toMatchObject({ code: 'RUNNER_UNAVAILABLE', retryable: true });
  });

  it('surfaces typed Docker daemon failures', async () => {
    const docker = { available: false, error: { code: 'DOCKER_UNAVAILABLE', message: 'Start Docker.', retryable: true } };
    const { app } = createTestApp({ runner: fakeRunner({ docker }) });
    const browser = await createBrowser(app);
    const response = await browser.get('/api/capabilities');
    expect(response.body).toMatchObject({ runner: { status: 'connected' }, docker: { available: false, error: { code: 'DOCKER_UNAVAILABLE' } }, labs: [] });
    const create = await browser.post('/api/sessions', { labId: 'stopped-container' });
    expect(create.status).toBe(503);
    expect(create.body.error).toMatchObject({ code: 'DOCKER_UNAVAILABLE', message: 'Start Docker.' });
  });

  it('advertises unavailable local execution in Demo mode', async () => {
    const { app } = createTestApp({ mode: 'demo', runner: null });
    const browser = await createBrowser(app);
    expect((await browser.get('/api/capabilities')).body).toMatchObject({ mode: 'demo', runner: { status: 'disabled' }, operations: [] });
    const create = await browser.post('/api/sessions', { labId: 'stopped-container' });
    expect(create.status).toBe(503);
    expect(create.body.error.code).toBe('LOCAL_MODE_UNAVAILABLE');
  });

  it('serves the workbench with its execution mode', async () => {
    const { app } = createTestApp();
    const page = await request(app).get('/').set('Host', HOST);
    expect(page.status).toBe(200);
    expect(page.text).toContain('<meta name="devops-playground-mode" content="local" />');
    expect((await request(app).get('/api/nope').set('Host', HOST).set('Origin', ORIGIN)).status).toBe(404);
  });
});
