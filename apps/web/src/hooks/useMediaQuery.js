import { useCallback, useSyncExternalStore } from 'react';

export function useMediaQuery(query, fallback = true) {
  const subscribe = useCallback((onChange) => {
    if (typeof window.matchMedia !== 'function') {
      return () => {};
    }
    const list = window.matchMedia(query);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  const read = () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : fallback);
  return useSyncExternalStore(subscribe, read, () => fallback);
}
