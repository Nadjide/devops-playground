import { createLabSession, labCatalog, reduceSession } from '@devops-playground/lab-core';
import { createStore } from './store.js';
import { ClientError, toClientError } from './errors.js';

const EVENT_HISTORY_LIMIT = 1000;
const defaultNow = () => new Date().toISOString();
const defaultNextId = () => globalThis.crypto.randomUUID();

export const DEMO_CAPABILITIES = Object.freeze({
  mode: 'demo',
  source: 'simulator',
  backend: 'Browser simulator',
  operations: Object.freeze([]),
});

function activationEvent(session, occurredAt) {
  const sequence = session.lastEventSequence + 1;
  return {
    schemaVersion: 1,
    id: `${session.id}:${session.eventEpoch}:${sequence}`,
    sessionId: session.id,
    generation: session.generation,
    eventEpoch: session.eventEpoch,
    sequence,
    revision: session.revision + 1,
    type: 'session.status-changed',
    occurredAt,
    operationId: null,
    source: 'simulator',
    payload: { status: 'active' },
  };
}

/**
 * Browser-only session client. It owns the complete demo session and never
 * performs network requests.
 */
export function createDemoClient({ labId = labCatalog[0].id, now = defaultNow, nextId = defaultNextId } = {}) {
  const store = createStore({
    status: 'loading',
    connection: 'connecting',
    session: null,
    events: [],
    error: null,
  });
  let disposed = false;

  function initialize() {
    store.set({ status: 'loading', connection: 'connecting', error: null });
    return Promise.resolve().then(() => {
      const created = createLabSession({ labId, mode: 'demo', now, nextId });
      const event = activationEvent(created, now());
      const session = reduceSession(created, event);
      if (!disposed) {
        store.set({ status: 'ready', connection: 'ready', session, events: [event].slice(-EVENT_HISTORY_LIMIT) });
      }
    }).catch((error) => {
      if (!disposed) {
        store.set({ status: 'error', connection: 'disconnected', error: toClientError(error) });
      }
    });
  }

  const ready = initialize();

  return {
    mode: 'demo',
    capabilities: DEMO_CAPABILITIES,
    ready,
    getSnapshot: store.get,
    subscribe: store.subscribe,
    listenerCount: store.listenerCount,
    retry: initialize,
    isAvailable(operationType) {
      return DEMO_CAPABILITIES.operations.includes(operationType);
    },
    async dispatch(request) {
      throw new ClientError('CAPABILITY_UNAVAILABLE',
        `The ${request?.type ?? 'requested'} operation is not available in this session.`);
    },
    dispose() {
      disposed = true;
    },
  };
}
