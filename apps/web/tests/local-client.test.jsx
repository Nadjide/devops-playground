import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFixtureResources, createSession, getLabManifest, reduceSession } from '@devops-playground/lab-core';
import { createLocalClient } from '../src/session/local-client.js';
import { App } from '../src/App.jsx';

function localSession() {
  const ids = ['local-session', 'epoch-1'];
  const resources = createFixtureResources('api-stopped', { sessionId: 'local-session', generation: 1, observedAt: '2026-11-04T10:00:00.000Z', source: 'docker' });
  const created = createSession({ manifest: getLabManifest('stopped-container'), mode: 'local', resources, now: () => '2026-11-04T10:00:00.000Z', nextId: () => ids.shift() });
  return reduceSession(created, event(created, 1, 'session.status-changed', { status: 'active' }));
}

function event(session, sequence, type, payload) {
  return {
    schemaVersion: 1, id: `${session.id}:${session.eventEpoch}:${sequence}`, sessionId: session.id, generation: 1, eventEpoch: session.eventEpoch,
    sequence, revision: sequence, type, occurredAt: '2026-11-04T10:00:01.000Z', operationId: null, source: 'docker', payload,
  };
}

class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.readyState = 1;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name, listener) {
    (this.listeners[name] ??= []).push(listener);
  }
  emit(name, data) {
    for (const listener of this.listeners[name] ?? []) {
      listener({ data: JSON.stringify(data) });
    }
  }
  close() {
    this.readyState = 2;
  }
}

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = vi.fn(async (path, init = {}) => {
    calls.push({ path, method: init.method ?? 'GET', headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const handler = routes[`${init.method ?? 'GET'} ${path}`];
    const [status, body] = handler ? handler(init) : [404, { error: { code: 'NOT_FOUND', message: 'missing' } }];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  return { fetchImpl, calls };
}

const capabilities = (extra = {}) => ({
  mode: 'local', operations: ['container.start', 'container.logs', 'health.probe', 'session.end'],
  runner: { status: 'connected' }, docker: { available: true, serverVersion: '29.7.2', apiVersion: '1.55' },
  labs: [{ id: 'stopped-container' }], recoverable: [], ...extra,
});

describe('local session client', () => {
  it('shows real diagnostics instead of simulating when Docker is unavailable', async () => {
    const { fetchImpl } = fakeFetch({
      'GET /api/security/csrf': () => [200, { token: 't' }],
      'GET /api/capabilities': () => [200, capabilities({ docker: { available: false, error: { code: 'DOCKER_UNAVAILABLE', message: 'Start Docker Desktop.' } }, labs: [] })],
    });
    const client = createLocalClient({ fetchImpl, EventSourceImpl: FakeEventSource });
    await client.ready;
    render(<App client={client} />);
    expect(screen.getByRole('heading', { name: 'Local Docker diagnostics' })).toBeInTheDocument();
    expect(screen.getByText('Start Docker Desktop.')).toBeInTheDocument();
    expect(screen.getByText('Local Docker')).toBeInTheDocument();
  });

  it('offers recover or clean up for resources left by a controller restart', async () => {
    const recoverable = [{ sessionId: 'orphan', generation: 2, labId: 'stopped-container', fixtureId: 'api-stopped', containers: [{ name: 'dpg-orphan-g2-api', state: 'running' }], networks: ['dpg-orphan-g2'] }];
    const session = localSession();
    const { fetchImpl, calls } = fakeFetch({
      'GET /api/security/csrf': () => [200, { token: 'csrf-token' }],
      'GET /api/capabilities': () => [200, capabilities({ recoverable })],
      'GET /api/sessions': () => [200, { sessions: [] }],
      'POST /api/recovery/orphan': () => [201, { session }],
    });
    const client = createLocalClient({ fetchImpl, EventSourceImpl: FakeEventSource });
    await client.ready;
    render(<App client={client} />);
    expect(screen.getByText(/dpg-orphan-g2-api \(running\)/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Recover session' }));
    await vi.waitFor(() => expect(client.getSnapshot()).toMatchObject({ status: 'ready', session: { id: 'local-session' } }));
    const recovery = calls.find((call) => call.path === '/api/recovery/orphan');
    expect(recovery).toMatchObject({ method: 'POST', body: { action: 'recover' } });
    expect(recovery.headers['x-csrf-token']).toBe('csrf-token');
  });

  it('mirrors SSE events through the shared reducer, deduplicates them, and refreshes after a gap', async () => {
    FakeEventSource.instances.length = 0;
    const session = localSession();
    const { fetchImpl, calls } = fakeFetch({
      'GET /api/security/csrf': () => [200, { token: 't' }],
      'GET /api/capabilities': () => [200, capabilities()],
      'GET /api/sessions': () => [200, { sessions: [session] }],
      [`GET /api/sessions/${session.id}`]: () => [200, { session }],
    });
    const client = createLocalClient({ fetchImpl, EventSourceImpl: FakeEventSource });
    await client.ready;
    const stream = FakeEventSource.instances[0];
    expect(stream.url).toBe(`/api/sessions/${session.id}/events`);

    const observed = event(session, 2, 'resource.observed', { resourceId: 'api-g1', state: 'running', health: 'healthy' });
    stream.emit('domain', observed);
    stream.emit('domain', observed);
    expect(client.getSnapshot().session.resources[0].observed).toMatchObject({ state: 'running', source: 'docker' });
    expect(client.getSnapshot().events).toHaveLength(1);
    expect(client.isAvailable('container.start')).toBe(true);
    expect(client.isAvailable('service.configure')).toBe(false);

    stream.emit('domain', event(session, 9, 'resource.observed', { resourceId: 'api-g1', state: 'stopped' }));
    await vi.waitFor(() => expect(calls.some((call) => call.path === `/api/sessions/${session.id}`)).toBe(true));
  });
});
