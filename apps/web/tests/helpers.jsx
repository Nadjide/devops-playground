import { render } from '@testing-library/react';
import { App } from '../src/App.jsx';
import { createDemoClient } from '../src/session/demo-client.js';

export const NOW = '2026-11-04T10:00:00.000Z';

export function createTestClient(options = {}) {
  let counter = 0;
  return createDemoClient({
    now: () => NOW,
    nextId: () => `id-${String(++counter).padStart(3, '0')}`,
    ...options,
  });
}

export async function renderApp(options = {}) {
  const client = options.client ?? createTestClient();
  await client.ready;
  const view = render(<App client={client} />);
  return { client, ...view };
}
