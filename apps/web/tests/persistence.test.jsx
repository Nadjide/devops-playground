import { describe, expect, it } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SIMULATED_TIMINGS } from '@devops-playground/lab-core';
import { CHECKPOINT_KEY, createBrowserStorage, createMemoryStorage, LAYOUT_KEY } from '../src/session/persistence.js';
import { createTestClient, renderApp } from './helpers.jsx';
import { setDesktopViewport } from './setup.js';

async function runAll(client) {
  await act(() => client.clock.runAll());
}

describe('demo checkpoints', () => {
  it('restores a compatible session and mission progress after reload', async () => {
    const storage = createMemoryStorage();
    const first = createTestClient({ storage });
    await first.ready;
    await first.dispatch({ type: 'container.logs', generation: 1, parameters: { serviceId: 'api', tail: 50 } });
    await first.dispatch({ type: 'container.start', generation: 1, parameters: { serviceId: 'api' } });
    await first.clock.runAll();
    expect(first.getSnapshot().persistence.status).toBe('saved');
    const saved = first.getSnapshot().session;
    first.dispose();

    const second = createTestClient({ storage });
    await renderApp({ client: second });
    const session = second.getSnapshot().session;
    expect(session).toMatchObject({ id: saved.id, labId: 'stopped-container', generation: 1 });
    expect(session.mission.objectives.map((objective) => objective.status)).toEqual(['satisfied', 'satisfied', 'pending']);
    expect(screen.getByText(/Restored your saved demo session/)).toBeInTheDocument();
    await runAll(second);
    expect(screen.getByText('Progress saved locally')).toBeInTheDocument();
  });

  it('restores the selected mission and resets after reloading during an operation', async () => {
    const storage = createMemoryStorage();
    const first = createTestClient({ storage });
    await first.ready;
    await first.startSession({ labId: 'wrong-port' });
    await first.dispatch({ type: 'container.restart', generation: 1, parameters: { serviceId: 'api' } });
    await first.clock.advance(SIMULATED_TIMINGS.stop + SIMULATED_TIMINGS.startup / 2);
    expect(first.getSnapshot().session.resources[0].observed.state).toBe('starting');
    first.dispose();

    const second = createTestClient({ storage });
    await second.ready;
    const session = second.getSnapshot().session;
    expect(session.labId).toBe('wrong-port');
    expect(session.resources[0].observed.state).toBe('stopped');
    expect(session.operations.at(-1).status).toBe('cancelled');
    await second.dispatch({ type: 'session.reset', generation: 1, parameters: {} });
    await second.clock.runAll();
    expect(second.getSnapshot().session).toMatchObject({ generation: 2, status: 'active' });
  });

  it.each([
    ['{corrupt', /not valid JSON/],
    [JSON.stringify({ checkpointVersion: 9, session: { schemaVersion: 1 } }), /checkpoint version 9/],
  ])('offers an explicit recovery choice for unusable saved text %#', async (text, message) => {
    const storage = createMemoryStorage({ [CHECKPOINT_KEY]: text });
    const client = createTestClient({ storage });
    const actor = userEvent.setup();
    await renderApp({ client });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(client.getSnapshot().session.status).toBe('active');
    await runAll(client);
    expect(storage.read(CHECKPOINT_KEY).value).toBe(text);

    await actor.click(within(alert).getByRole('button', { name: 'Discard saved progress' }));
    await runAll(client);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(JSON.parse(storage.read(CHECKPOINT_KEY).value)).toMatchObject({ checkpointVersion: 1 });
  });

  it('can continue without overwriting unusable saved progress', async () => {
    const storage = createMemoryStorage({ [CHECKPOINT_KEY]: '{corrupt' });
    const client = createTestClient({ storage });
    const actor = userEvent.setup();
    await renderApp({ client });
    await actor.click(screen.getByRole('button', { name: 'Continue without saving' }));
    await client.dispatch({ type: 'container.start', generation: 1, parameters: { serviceId: 'api' } });
    await runAll(client);
    expect(storage.read(CHECKPOINT_KEY).value).toBe('{corrupt');
    expect(screen.getByText('Saving paused')).toBeInTheDocument();
  });

  it('keeps the session usable when storage quota is exceeded', async () => {
    const quota = Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    const storage = createBrowserStorage(() => ({
      getItem: () => null,
      setItem: () => { throw quota; },
      removeItem: () => {},
    }));
    const client = createTestClient({ storage });
    await renderApp({ client });
    await client.dispatch({ type: 'container.start', generation: 1, parameters: { serviceId: 'api' } });
    await runAll(client);
    expect(client.getSnapshot().session.resources[0].observed.state).toBe('running');
    expect(client.getSnapshot().persistence).toMatchObject({ status: 'unavailable', message: expect.stringMatching(/storage is full/) });
    expect(screen.getByText('Progress not saved')).toBeInTheDocument();
  });

  it('starts normally when browser storage access is denied', async () => {
    const storage = createBrowserStorage(() => {
      throw Object.assign(new Error('denied'), { name: 'SecurityError' });
    });
    const client = createTestClient({ storage });
    await renderApp({ client });
    expect(client.getSnapshot().session.status).toBe('active');
    expect(screen.getByText('Progress not saved')).toBeInTheDocument();
  });
});

describe('layout preferences and observation age', () => {
  it('remembers the compact panel selection separately from the checkpoint', async () => {
    setDesktopViewport(false);
    const storage = createMemoryStorage();
    const actor = userEvent.setup();
    const { unmount } = await renderApp({ client: createTestClient({ storage }) });
    await actor.click(within(screen.getByRole('tablist', { name: 'Workbench panels' })).getByRole('tab', { name: 'Docker' }));
    expect(JSON.parse(storage.read(LAYOUT_KEY).value)).toEqual({ compactTab: 'docker' });
    unmount();

    await renderApp({ client: createTestClient({ storage }) });
    expect(within(screen.getByRole('tablist', { name: 'Workbench panels' })).getByRole('tab', { name: 'Docker' }))
      .toHaveAttribute('aria-selected', 'true');
  });

  it('ignores corrupt layout preferences', async () => {
    const storage = createMemoryStorage({ [LAYOUT_KEY]: '{"desktopSelection":{"primary":"evil"}' });
    await renderApp({ client: createTestClient({ storage }) });
    expect(screen.getByRole('tab', { name: 'Docker' })).toHaveAttribute('aria-selected', 'true');
  });

  it('marks old observations as stale', async () => {
    const client = createTestClient();
    await client.ready;
    await client.clock.advance(90_000);
    await renderApp({ client });
    const containers = screen.getByRole('list', { name: 'Session containers' });
    expect(within(containers).getByText(/2 min ago/)).toBeInTheDocument();
    expect(within(containers).getByText('stale')).toBeInTheDocument();
  });
});
