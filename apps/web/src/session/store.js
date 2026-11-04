/**
 * Minimal external store compatible with React's useSyncExternalStore.
 * Snapshots are replaced, never mutated, so React can compare by identity.
 */
export function createStore(initialState) {
  let state = initialState;
  const listeners = new Set();

  return {
    get: () => state,
    set(update) {
      state = { ...state, ...update };
      for (const listener of [...listeners]) {
        listener();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    listenerCount: () => listeners.size,
  };
}
