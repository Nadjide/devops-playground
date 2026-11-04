export const CHECKPOINT_KEY = 'devops-playground:demo-checkpoint:v1';
export const LAYOUT_KEY = 'devops-playground:layout:v1';

function describe(error) {
  if (error?.name === 'QuotaExceededError' || error?.code === 22) {
    return { reason: 'quota', message: 'Browser storage is full, so progress is not being saved.' };
  }
  return { reason: 'denied', message: 'Browser storage is unavailable, so progress is not being saved.' };
}

/**
 * Wrap Web Storage so denial, quota failures, and missing storage never throw
 * into the workbench. Every call returns a typed result.
 */
export function createBrowserStorage(resolve = () => globalThis.localStorage) {
  function backend() {
    const storage = resolve();
    if (!storage) {
      throw new Error('Storage unavailable');
    }
    return storage;
  }
  return {
    read(key) {
      try {
        return { ok: true, value: backend().getItem(key) };
      } catch (error) {
        return { ok: false, ...describe(error) };
      }
    },
    write(key, value) {
      try {
        backend().setItem(key, value);
        return { ok: true };
      } catch (error) {
        return { ok: false, ...describe(error) };
      }
    },
    remove(key) {
      try {
        backend().removeItem(key);
        return { ok: true };
      } catch (error) {
        return { ok: false, ...describe(error) };
      }
    },
  };
}

/** In-memory storage with the same contract, for tests and storage-less contexts. */
export function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return createBrowserStorage(() => ({
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  }));
}

/** Purely visual preferences, stored apart from domain checkpoints. */
export function readLayout(storage) {
  const result = storage.read(LAYOUT_KEY);
  if (!result.ok || !result.value) {
    return {};
  }
  try {
    const value = JSON.parse(result.value);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function writeLayout(storage, patch) {
  const next = { ...readLayout(storage), ...patch };
  const text = JSON.stringify(next);
  if (text.length <= 8 * 1024) {
    storage.write(LAYOUT_KEY, text);
  }
  return next;
}
