import { useCallback, useState } from 'react';
import { useSessionClient } from '../session/SessionContext.jsx';
import { readLayout, writeLayout } from '../session/persistence.js';

/**
 * Visual preference persisted apart from domain checkpoints. Invalid or
 * unavailable storage silently falls back to the default value.
 */
export function useLayoutPreference(key, fallback, isValid = () => true) {
  const client = useSessionClient();
  const [value, setValue] = useState(() => {
    const stored = client.storage ? readLayout(client.storage)[key] : undefined;
    return stored !== undefined && isValid(stored) ? stored : fallback;
  });
  const update = useCallback((next) => {
    setValue((current) => {
      const resolved = typeof next === 'function' ? next(current) : next;
      if (client.storage) {
        writeLayout(client.storage, { [key]: resolved });
      }
      return resolved;
    });
  }, [client, key]);
  return [value, update];
}

export const isLayout = (ids) => (value) => value && typeof value === 'object' &&
  ids.every((id) => typeof value[id] === 'number' && value[id] >= 0 && value[id] <= 100);
