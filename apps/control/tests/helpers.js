import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createSimulatorExecutor, createVirtualClock, SIMULATED_OPERATIONS } from '@devops-playground/lab-core';
import { createControlApp } from '../src/app.js';
import { createSessionStore } from '../src/sessions/store.js';

export const ORIGIN = 'http://127.0.0.1:3001';
export const HOST = '127.0.0.1:3001';

/** Simulator wrapped to report Docker provenance, standing in for the runner in API tests. */
export function dockerShapedExecutor() {
  const simulator = createSimulatorExecutor();
  return {
    ...simulator,
    backend: 'Test Docker backend',
    async setup(input) {
      const setup = await simulator.setup(input);
      return {
        ...setup,
        resources: setup.resources.map((resource) => ({ ...resource, observed: { ...resource.observed, source: 'docker' } })),
      };
    },
  };
}

export function fakeRunner({ healthy = true, docker = { available: true, serverVersion: '29.7.2', apiVersion: '1.52' } } = {}) {
  return {
    health: async () => (healthy ? { ok: true, body: { status: 'ok' } } : {
      ok: false, status: 503, error: { code: 'RUNNER_UNAVAILABLE', message: 'The local runner is not reachable.', retryable: true },
    }),
    docker: async () => (docker.available ? { ok: true, body: docker } : { ok: false, status: 503, body: docker, error: docker.error }),
  };
}

export function staticDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pg-web-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><title>DevOps Playground</title></head><body></body></html>');
  return dir;
}

export function createTestApp({ mode = 'local', runner = fakeRunner(), operations = SIMULATED_OPERATIONS, store, logger } = {}) {
  const config = {
    mode,
    allowedHosts: [HOST, 'localhost:3001'],
    allowedOrigins: [ORIGIN, 'http://localhost:3001'],
    csrfSecret: Buffer.from('0123456789abcdef0123456789abcdef'),
    cookieSecure: false,
    staticDir: staticDir(),
  };
  const clock = createVirtualClock();
  let counter = 0;
  const sessionStore = store ?? createSessionStore({
    executorFactory: dockerShapedExecutor,
    clock,
    nextId: () => `id-${String(++counter).padStart(4, '0')}`,
  });
  const app = createControlApp({ config, store: sessionStore, runner, operations, logger: logger ?? { error() {} } });
  return { app, clock, store: sessionStore, config };
}

/** A browser: keeps its session cookie and CSRF token and sends same-origin headers. */
export async function createBrowser(app) {
  const agent = request.agent(app);
  const response = await agent.get('/api/security/csrf').set('Host', HOST);
  const token = response.body.token;
  const withHeaders = (req) => req.set('Host', HOST).set('Origin', ORIGIN);
  return {
    agent,
    token,
    cookie: response.headers['set-cookie'],
    get: (path) => withHeaders(agent.get(path)),
    post: (path, body, { key, csrf = token } = {}) => {
      let req = withHeaders(agent.post(path)).set('X-CSRF-Token', csrf ?? '');
      if (key) {
        req = req.set('Idempotency-Key', key);
      }
      return req.send(body);
    },
  };
}
