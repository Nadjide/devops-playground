import { getLabManifest, reduceSession, replaceSessionSnapshot } from '@devops-playground/lab-core';
import { createStore } from './store.js';
import { ClientError, toClientError } from './errors.js';

const EVENT_LIMIT = 1000;
const NOTICE_LIMIT = 5;
const TERMINAL = ['succeeded', 'failed', 'cancelled'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Session client for a packaged portal in Local Docker mode. State lives in
 * the control API; the browser mirrors it through SSE using the shared reducer
 * and never substitutes simulated observations for unavailable execution.
 */
export function createLocalClient({
  fetchImpl = globalThis.fetch.bind(globalThis),
  EventSourceImpl = globalThis.EventSource,
  now = () => Date.now(),
  pollMs = 400,
} = {}) {
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
    loadingMessage: 'Connecting to the local runner…',
  });
  let csrf = null;
  let labs = [];
  let operations = [];
  let selection = { labId: null, fixtureId: null };
  let source = null;
  let noticeCounter = 0;
  let disposed = false;

  async function api(method, path, { body, key } = {}) {
    const headers = { accept: 'application/json' };
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      headers['x-csrf-token'] = csrf ?? '';
    }
    if (key) {
      headers['idempotency-key'] = key;
    }
    let response;
    try {
      response = await fetchImpl(path, { method, headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw new ClientError('CONTROL_UNREACHABLE', 'The workbench control service is not reachable.', { retryable: true });
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = payload?.error ?? {};
      throw new ClientError(error.code ?? 'REQUEST_FAILED', error.message ?? 'The control service rejected the request.', {
        status: response.status, retryable: error.retryable ?? false, operationId: error.operationId ?? null, details: error.details ?? {},
      });
    }
    return payload;
  }

  function closeStream() {
    source?.close();
    source = null;
  }

  async function refresh() {
    const current = store.get().session;
    if (!current) {
      return;
    }
    try {
      const { session } = await api('GET', `/api/sessions/${current.id}`);
      let next = session;
      try {
        next = replaceSessionSnapshot(current, session);
      } catch {
        next = session;
      }
      store.set({ session: next, connection: 'ready' });
    } catch (error) {
      store.set({ connection: 'disconnected', error: toClientError(error) });
    }
  }

  function apply(event) {
    const current = store.get().session;
    if (!current || event.sessionId !== current.id) {
      return;
    }
    if (event.eventEpoch !== current.eventEpoch || event.sequence > current.lastEventSequence + 1) {
      refresh();
      return;
    }
    if (event.sequence <= current.lastEventSequence) {
      return;
    }
    try {
      const session = reduceSession(current, event);
      store.set({ session, events: [...store.get().events, event].slice(-EVENT_LIMIT) });
    } catch {
      refresh();
    }
  }

  function openStream(sessionId) {
    closeStream();
    if (!EventSourceImpl) {
      return;
    }
    const stream = new EventSourceImpl(`/api/sessions/${sessionId}/events`);
    source = stream;
    stream.addEventListener('open', () => store.set({ connection: 'ready' }));
    stream.addEventListener('domain', (message) => apply(JSON.parse(message.data)));
    stream.addEventListener('snapshot.required', () => refresh());
    stream.addEventListener('error', () => {
      // EventSource reconnects with Last-Event-ID; a closed stream needs a fresh snapshot.
      store.set({ connection: 'reconnecting' });
      if (stream.readyState === 2 && !disposed) {
        setTimeout(async () => {
          if (source === stream) {
            await refresh();
            openStream(sessionId);
          }
        }, 2000);
      }
    });
  }

  function attach(session) {
    selection = { labId: session.labId, fixtureId: session.fixtureId };
    store.set({ status: 'ready', connection: 'ready', session, events: [], error: null });
    openStream(session.id);
  }

  async function createSession(labId, fixtureId = null) {
    const lab = getLabManifest(labId);
    store.set({ status: 'loading', loadingMessage: `Preparing “${lab.title}” on local Docker (building the approved image and starting containers)…` });
    const { session } = await api('POST', '/api/sessions', { body: { labId, fixtureId } });
    attach(session);
  }

  async function initialize() {
    closeStream();
    store.set({ status: 'loading', connection: 'connecting', session: null, events: [], error: null, loadingMessage: 'Connecting to the local runner…' });
    try {
      ({ token: csrf } = await api('GET', '/api/security/csrf'));
      const capabilities = await api('GET', '/api/capabilities');
      labs = capabilities.labs.map((lab) => getLabManifest(lab.id));
      operations = capabilities.operations;
      if (capabilities.runner?.status !== 'connected' || !capabilities.docker?.available || labs.length === 0) {
        store.set({ status: 'unavailable', connection: capabilities.runner?.status === 'connected' ? 'ready' : 'disconnected', diagnostics: capabilities });
        return;
      }
      const { sessions } = await api('GET', '/api/sessions');
      const existing = sessions.find((session) => session.status !== 'ended');
      if (existing) {
        attach(existing);
      } else if (capabilities.recoverable?.length) {
        // Resources from before a controller restart: the owner chooses recover or clean up.
        store.set({ status: 'recovery', connection: 'ready', recoverable: capabilities.recoverable });
      } else {
        await createSession(selection.labId ?? labs[0].id, selection.fixtureId);
      }
    } catch (error) {
      store.set({ status: 'error', connection: 'disconnected', error: toClientError(error) });
    }
  }

  function notice(type, error) {
    noticeCounter += 1;
    const entry = { id: `notice-${noticeCounter}`, type, code: error.code, message: error.message, at: new Date(now()).toISOString() };
    store.set({ notices: [...store.get().notices, entry].slice(-NOTICE_LIMIT) });
  }

  async function dispatch(request, { idempotencyKey = `ui-${globalThis.crypto.randomUUID()}` } = {}) {
    const session = store.get().session;
    try {
      if (!session) {
        throw new ClientError('SESSION_UNAVAILABLE', 'The session is not ready.');
      }
      const { operation } = await api('POST', `/api/sessions/${session.id}/operations`, { body: request, key: idempotencyKey });
      return operation;
    } catch (error) {
      const clientError = toClientError(error);
      notice(request?.type ?? 'unknown', clientError);
      throw clientError;
    }
  }

  async function settled(operationId) {
    const sessionId = store.get().session?.id;
    for (;;) {
      const { operation } = await api('GET', `/api/sessions/${sessionId}/operations/${operationId}`);
      if (TERMINAL.includes(operation.status)) {
        return operation;
      }
      await sleep(pollMs);
    }
  }

  const ready = initialize();

  return {
    mode: 'local',
    capabilities: { mode: 'local', source: 'docker', backend: 'Local Docker' },
    ready,
    get labs() {
      return labs;
    },
    storage: null,
    now,
    selection: () => selection,
    /** End the current session (cleaning its resources), then create the requested one. */
    async startSession({ labId, fixtureId = null }) {
      selection = { labId, fixtureId };
      const current = store.get().session;
      try {
        if (current && current.status !== 'ended') {
          const end = await dispatch({ type: 'session.end', generation: current.generation, parameters: {} });
          await settled(end.id);
        }
        closeStream();
        await createSession(labId, fixtureId);
      } catch (error) {
        store.set({ status: 'error', connection: 'disconnected', error: toClientError(error) });
      }
    },
    async recover(sessionId) {
      store.set({ status: 'loading', loadingMessage: 'Re-observing the session resources…' });
      try {
        const { session } = await api('POST', `/api/recovery/${sessionId}`, { body: { action: 'recover' } });
        attach(session);
      } catch (error) {
        store.set({ status: 'error', connection: 'disconnected', error: toClientError(error) });
      }
    },
    async cleanupRecoverable(sessionId) {
      store.set({ status: 'loading', loadingMessage: 'Removing the owned resources of that session…' });
      try {
        const { cleanup } = await api('POST', `/api/recovery/${sessionId}`, { body: { action: 'cleanup' } });
        store.set({ lastCleanup: cleanup });
        await initialize();
      } catch (error) {
        store.set({ status: 'error', connection: 'disconnected', error: toClientError(error) });
      }
    },
    /** Real CPU and memory samples for the session workloads (Local Docker only). */
    async metrics() {
      const session = store.get().session;
      if (!session || session.status !== 'active') {
        return null;
      }
      return api('GET', `/api/sessions/${session.id}/metrics`);
    },
    discardSavedProgress() {},
    continueWithoutSaving() {},
    getSnapshot: store.get,
    subscribe: store.subscribe,
    listenerCount: store.listenerCount,
    async retry() {
      const current = store.get().session;
      if (current?.status === 'ended') {
        selection = { labId: current.labId, fixtureId: current.fixtureId };
      }
      return initialize();
    },
    /** Available when the backend implements it and the active lab allows it. */
    isAvailable(type) {
      const session = store.get().session;
      return operations.includes(type) && Boolean(session) && getLabManifest(session.labId).allowedOperations.includes(type);
    },
    getOperation: () => null,
    settled,
    dispatch,
    dispose() {
      disposed = true;
      closeStream();
    },
  };
}
