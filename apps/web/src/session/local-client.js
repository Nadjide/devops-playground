import { createStore } from './store.js';
import { ClientError, toClientError } from './errors.js';

async function getJson(path, { fetchImpl }) {
  const response = await fetchImpl(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ClientError(body?.error?.code ?? 'REQUEST_FAILED', body?.error?.message ?? 'The control service rejected the request.', {
      status: response.status, retryable: body?.error?.retryable ?? true,
    });
  }
  return body;
}

/**
 * Session client for a packaged portal in Local Docker mode. It reports the
 * real controller, runner, and daemon status and never substitutes simulated
 * observations for unavailable local execution.
 */
export function createLocalClient({ fetchImpl = globalThis.fetch.bind(globalThis), now = () => Date.now() } = {}) {
  const store = createStore({
    status: 'loading',
    connection: 'connecting',
    session: null,
    events: [],
    notices: [],
    error: null,
    recovery: null,
    persistence: null,
    diagnostics: null,
  });

  async function initialize() {
    store.set({ status: 'loading', connection: 'connecting', error: null });
    try {
      await getJson('/api/security/csrf', { fetchImpl });
      const capabilities = await getJson('/api/capabilities', { fetchImpl });
      store.set({
        status: 'unavailable',
        connection: capabilities.runner?.status === 'connected' ? 'ready' : 'disconnected',
        diagnostics: capabilities,
      });
    } catch (error) {
      store.set({ status: 'error', connection: 'disconnected', error: toClientError(error) });
    }
  }

  const ready = initialize();

  return {
    mode: 'local',
    capabilities: { mode: 'local', source: 'docker', backend: 'Local Docker' },
    ready,
    labs: [],
    storage: null,
    now,
    selection: () => ({ labId: null, fixtureId: null }),
    startSession: () => Promise.reject(new ClientError('CAPABILITY_UNAVAILABLE', 'Local labs are not available yet.')),
    discardSavedProgress() {},
    continueWithoutSaving() {},
    getSnapshot: store.get,
    subscribe: store.subscribe,
    listenerCount: store.listenerCount,
    retry: initialize,
    isAvailable: () => false,
    getOperation: () => null,
    settled: () => Promise.reject(new ClientError('CAPABILITY_UNAVAILABLE', 'Local operations are not available yet.')),
    dispatch: () => Promise.reject(new ClientError('CAPABILITY_UNAVAILABLE', 'Local operations are not available yet.')),
    dispose() {},
  };
}
