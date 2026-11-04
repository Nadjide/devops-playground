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
    expect(state.session).toMatchObject({ mode: 'demo', status: 'active', revision: 1, labId: 'stopped-container' });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ type: 'session.status-changed', source: 'simulator' });
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

  it('reports operations as unavailable capabilities', async () => {
    const client = createTestClient();
    await client.ready;
    expect(client.isAvailable('container.start')).toBe(false);
    await expect(client.dispatch({ type: 'container.start', generation: 1, parameters: { serviceId: 'api' } }))
      .rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
  });

  it('exposes an error state when the session cannot be created', async () => {
    const client = createTestClient({ labId: 'missing-lab' });
    await client.ready;
    expect(client.getSnapshot()).toMatchObject({ status: 'error', connection: 'disconnected' });
    expect(client.getSnapshot().error.message).toMatch(/Unknown lab/);
  });
});
