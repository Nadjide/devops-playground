import { act, render } from '@testing-library/react';
import { createVirtualClock } from '@devops-playground/lab-core';
import { App } from '../src/App.jsx';
import { createDemoClient } from '../src/session/demo-client.js';
import { createMemoryStorage } from '../src/session/persistence.js';

export function createTestClient(options = {}) {
  let counter = 0;
  const clock = options.clock ?? createVirtualClock();
  const client = createDemoClient({
    clock,
    nextId: () => `id-${String(++counter).padStart(4, '0')}`,
    onError: () => {},
    storage: createMemoryStorage(),
    ...options,
  });
  client.clock = clock;
  return client;
}

export async function renderApp(options = {}) {
  const client = options.client ?? createTestClient();
  await client.ready;
  const view = render(<App client={client} />);
  const advance = (ms) => act(() => client.clock.advance(ms));
  const settle = () => act(() => client.clock.runAll());
  return { client, advance, settle, ...view };
}
