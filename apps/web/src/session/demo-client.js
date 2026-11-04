import {
  availableLabs, createLabRuntime, createSimulatorExecutor, createSystemClock, parseCheckpoint, serializeCheckpoint,
} from '@devops-playground/lab-core';
import { createStore } from './store.js';
import { toClientError } from './errors.js';
import { CHECKPOINT_KEY, createBrowserStorage } from './persistence.js';

const NOTICE_LIMIT = 5;
const SAVE_DELAY_MS = 250;
const defaultNextId = () => globalThis.crypto.randomUUID();

/**
 * Browser-only session client. It owns the complete demo session through the
 * shared lab runtime and the deterministic simulator; it never uses the network.
 * Progress is saved as a versioned checkpoint; storage failures never block use.
 */
export function createDemoClient({
  labId: initialLab,
  fixtureId: initialFixture,
  clock = createSystemClock(),
  nextId = defaultNextId,
  executor = createSimulatorExecutor(),
  storage = createBrowserStorage(),
  onError = (error) => globalThis.console?.error(error),
} = {}) {
  const store = createStore({
    status: 'loading',
    connection: 'connecting',
    session: null,
    events: [],
    notices: [],
    error: null,
    recovery: null,
    persistence: { status: 'idle', message: null, savedAt: null },
  });
  let runtime = null;
  let unsubscribe = null;
  let disposed = false;
  let noticeCounter = 0;
  let saveTimer = null;
  let saving = true;
  const labs = availableLabs({ mode: 'demo', operations: executor.supportedOperations });
  let selection = { labId: initialLab ?? labs[0].id, fixtureId: initialFixture ?? null };
  let pendingRestore = null;

  // Read saved progress once; an unusable checkpoint pauses saving until the learner chooses.
  if (!initialLab && storage) {
    const stored = storage.read(CHECKPOINT_KEY);
    const parsed = stored.ok ? parseCheckpoint(stored.value) : { ok: false, reason: stored.reason, message: stored.message };
    if (parsed.ok && labs.some((lab) => lab.id === parsed.checkpoint.session.labId)) {
      pendingRestore = parsed.checkpoint.session;
      selection = { labId: pendingRestore.labId, fixtureId: pendingRestore.fixtureId };
    } else if (!parsed.ok && parsed.reason !== 'empty') {
      saving = parsed.reason === 'denied' || parsed.reason === 'quota';
      store.set(parsed.reason === 'denied' || parsed.reason === 'quota'
        ? { persistence: { status: 'unavailable', message: parsed.message, savedAt: null } }
        : { recovery: { reason: parsed.reason, message: parsed.message }, persistence: { status: 'paused', message: 'Saving is paused until you choose what to do with the saved progress.', savedAt: null } });
    }
  }

  function save() {
    saveTimer = null;
    const session = runtime?.getSession();
    if (!saving || !session || disposed) {
      return;
    }
    const serialized = serializeCheckpoint(session, { now: () => new Date(clock.now()).toISOString() });
    if (!serialized.ok) {
      store.set({ persistence: { status: 'unavailable', message: serialized.message, savedAt: null } });
      return;
    }
    const written = storage.write(CHECKPOINT_KEY, serialized.text);
    store.set({
      persistence: written.ok
        ? { status: 'saved', message: null, savedAt: new Date(clock.now()).toISOString() }
        : { status: 'unavailable', message: written.message, savedAt: null },
    });
  }

  function scheduleSave() {
    if (storage && saving && saveTimer === null) {
      saveTimer = clock.setTimeout(save, SAVE_DELAY_MS);
    }
  }

  function sync() {
    if (!disposed && runtime) {
      store.set({ session: runtime.getSession(), events: runtime.getEvents() });
      scheduleSave();
    }
  }

  async function initialize() {
    unsubscribe?.();
    runtime?.dispose();
    const restore = pendingRestore;
    pendingRestore = null;
    store.set({ status: 'loading', connection: 'connecting', session: null, events: [], notices: [], error: null });
    try {
      runtime = createLabRuntime({
        labId: selection.labId,
        fixtureId: selection.fixtureId ?? undefined,
        mode: 'demo',
        executor,
        clock,
        nextId,
        onError,
      });
      unsubscribe = runtime.subscribe(sync);
      try {
        await runtime.start({ restore });
      } catch (error) {
        if (!restore) {
          throw error;
        }
        // A checkpoint that cannot be hydrated becomes an explicit recovery choice.
        saving = false;
        store.set({
          recovery: { reason: 'invalid', message: 'Saved progress could not be restored into a session.' },
          persistence: { status: 'paused', message: 'Saving is paused until you choose what to do with the saved progress.', savedAt: null },
        });
        await runtime.start();
      }
      if (!disposed) {
        store.set({
          status: 'ready',
          connection: 'ready',
          session: runtime.getSession(),
          events: runtime.getEvents(),
          restored: Boolean(restore) && store.get().recovery === null,
        });
        scheduleSave();
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

  // Flush pending progress when the page is hidden or closed so a reload keeps it.
  const flush = () => {
    if (saveTimer !== null) {
      clock.clearTimeout(saveTimer);
      save();
    }
  };
  globalThis.addEventListener?.('pagehide', flush);

  const ready = initialize();

  return {
    mode: 'demo',
    capabilities: {
      mode: 'demo',
      source: 'simulator',
      backend: executor.backend ?? 'Browser simulator',
    },
    ready,
    labs,
    storage,
    now: () => clock.now(),
    selection: () => selection,
    /** Replace the session with a new one for another lab or fixture. */
    startSession({ labId, fixtureId = null }) {
      selection = { labId, fixtureId };
      return initialize();
    },
    /** Recovery choice: delete unusable saved progress and resume saving. */
    discardSavedProgress() {
      storage?.remove(CHECKPOINT_KEY);
      saving = true;
      store.set({ recovery: null, persistence: { status: 'idle', message: null, savedAt: null } });
      scheduleSave();
    },
    /** Recovery choice: keep the stored data untouched and do not save this session. */
    continueWithoutSaving() {
      saving = false;
      store.set({ recovery: null, persistence: { status: 'paused', message: 'Progress in this tab is not saved.', savedAt: null } });
    },
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
      globalThis.removeEventListener?.('pagehide', flush);
      disposed = true;
      if (saveTimer !== null) {
        clock.clearTimeout(saveTimer);
      }
      unsubscribe?.();
      runtime?.dispose();
    },
  };
}
