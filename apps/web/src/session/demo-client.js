import {
  createLabRuntime, createSimulatorExecutor, createSystemClock, labCatalog,
} from '@devops-playground/lab-core';
import { createStore } from './store.js';
import { toClientError } from './errors.js';

const NOTICE_LIMIT = 5;
const defaultNextId = () => globalThis.crypto.randomUUID();

/**
 * Browser-only session client. It owns the complete demo session through the
 * shared lab runtime and the deterministic simulator; it never uses the network.
 */
export function createDemoClient({
  labId = labCatalog[0].id,
  clock = createSystemClock(),
  nextId = defaultNextId,
  executor = createSimulatorExecutor(),
  onError = (error) => globalThis.console?.error(error),
} = {}) {
  const store = createStore({
    status: 'loading',
    connection: 'connecting',
    session: null,
    events: [],
    notices: [],
    error: null,
  });
  let runtime = null;
  let unsubscribe = null;
  let disposed = false;
  let noticeCounter = 0;

  function sync() {
    if (!disposed && runtime) {
      store.set({ session: runtime.getSession(), events: runtime.getEvents() });
    }
  }

  async function initialize() {
    unsubscribe?.();
    runtime?.dispose();
    store.set({ status: 'loading', connection: 'connecting', session: null, events: [], notices: [], error: null });
    try {
      runtime = createLabRuntime({ labId, mode: 'demo', executor, clock, nextId, onError });
      unsubscribe = runtime.subscribe(sync);
      await runtime.start();
      if (!disposed) {
        store.set({ status: 'ready', connection: 'ready', session: runtime.getSession(), events: runtime.getEvents() });
      }
    } catch (error) {
      if (!disposed) {
        store.set({ status: 'error', connection: 'disconnected', error: toClientError(error) });
      }
    }
  }

  function notice(type, error) {
    noticeCounter += 1;
    const entry = { id: `notice-${noticeCounter}`, type, code: error.code, message: error.message, at: new Date(clock.now()).toISOString() };
    store.set({ notices: [...store.get().notices, entry].slice(-NOTICE_LIMIT) });
  }

  const ready = initialize();

  return {
    mode: 'demo',
    capabilities: {
      mode: 'demo',
      source: 'simulator',
      backend: executor.backend ?? 'Browser simulator',
    },
    ready,
    getSnapshot: store.get,
    subscribe: store.subscribe,
    listenerCount: store.listenerCount,
    retry: initialize,
    isAvailable(operationType) {
      return Boolean(runtime?.capabilities().includes(operationType));
    },
    getOperation: (operationId) => runtime?.getOperation(operationId) ?? null,
    settled: (operationId) => runtime.settled(operationId),
    /** Request a typed operation. Rejections are typed ClientErrors and recorded as notices. */
    async dispatch(request, { idempotencyKey = `ui-${nextId()}` } = {}) {
      try {
        if (!runtime) {
          throw toClientError({ code: 'SESSION_UNAVAILABLE', message: 'The session is not ready.' });
        }
        return runtime.submit(request, { idempotencyKey });
      } catch (error) {
        const clientError = toClientError(error);
        notice(request?.type ?? 'unknown', clientError);
        throw clientError;
      }
    },
    dispose() {
      disposed = true;
      unsubscribe?.();
      runtime?.dispose();
    },
  };
}
