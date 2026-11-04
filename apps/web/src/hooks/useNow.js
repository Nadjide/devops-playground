import { useEffect, useState } from 'react';
import { useSessionClient } from '../session/SessionContext.jsx';

/** Current client time, refreshed periodically so ages and staleness stay accurate. */
export function useNow(intervalMs = 5000) {
  const client = useSessionClient();
  const [now, setNow] = useState(() => client.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(client.now()), intervalMs);
    return () => clearInterval(handle);
  }, [client, intervalMs]);
  return Math.max(now, client.now());
}
