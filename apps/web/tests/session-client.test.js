import { describe, expect, it, vi } from 'vitest';
import { sessionSchema } from '@devops-playground/lab-core';
import { createTestClient } from './helpers.jsx';

describe('demo session client', () => {
  it('starts in a loading state and becomes ready without network access', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const client = createTestClient();
    expect(client.getSnapshot()).toMatchObject({ status: 'loading', connection: 'connecting', session: null });

    await client.ready;
    const state = client.getSnapshot();
    expect(state.status).toBe('ready');
    expect(sessionSchema.parse(state.session)).toEqual(state.session);
    expect(state.session).toMatchObject({ mode: 'demo', status: 'active', labId: 'stopped-container' });
    expect(state.events.map((event) => event.type)).toEqual(['session.status-changed', 'log.appended']);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('notifies subscribers and stops after unsubscribe', async () => {
    const client = createTestClient();
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);
    await client.ready;
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    await client.retry();
    expect(listener).not.toHaveBeenCalled();
    expect(client.listenerCount()).toBe(0);
  });

  it('dispatches simulated operations through the shared runtime', async () => {
    const client = createTestClient();
    await client.ready;
    expect(client.isAvailable('container.start')).toBe(true);
    expect(client.isAvailable('service.configure')).toBe(false);
    const operation = await client.dispatch({ type: 'container.start', generation: 1, parameters: { serviceId: 'api' } });
    expect(operation.status).toBe('queued');
    const settled = client.settled(operation.id);
    await client.clock.runAll();
    expect(await settled).toMatchObject({ status: 'succeeded' });
    expect(client.getSnapshot().session.resources[0].observed.state).toBe('running');
  });

  it('rejects invalid requests with typed errors and records a notice', async () => {
    const client = createTestClient();
    await client.ready;
    await expect(client.dispatch({ type: 'container.start', generation: 1, parameters: { serviceId: 'db' } }))
      .rejects.toMatchObject({ code: 'UNKNOWN_SERVICE', status: 404 });
    await expect(client.dispatch({ type: 'container.exec', generation: 1, parameters: {} }))
      .rejects.toMatchObject({ code: 'INVALID_OPERATION', status: 400 });
    expect(client.getSnapshot().notices.map((notice) => notice.code)).toEqual(['UNKNOWN_SERVICE', 'INVALID_OPERATION']);
  });

  it('exposes an error state when the session cannot be created', async () => {
    const client = createTestClient({ labId: 'missing-lab' });
    await client.ready;
    expect(client.getSnapshot()).toMatchObject({ status: 'error', connection: 'disconnected' });
    expect(client.getSnapshot().error.message).toMatch(/Unknown lab/);
  });
});
