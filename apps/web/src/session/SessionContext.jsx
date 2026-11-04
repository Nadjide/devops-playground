import { createContext, useContext, useSyncExternalStore } from 'react';

const SessionContext = createContext(null);

export function SessionProvider({ client, children }) {
  return <SessionContext.Provider value={client}>{children}</SessionContext.Provider>;
}

export function useSessionClient() {
  const client = useContext(SessionContext);
  if (!client) {
    throw new Error('useSessionClient must be used inside a SessionProvider.');
  }
  return client;
}

export function useSessionState() {
  const client = useSessionClient();
  return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
}
