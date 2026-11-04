import { createContext, useContext, useMemo, useState } from 'react';
import { useSessionState } from '../session/SessionContext.jsx';
import { createCommandHistory, createTerminalState } from './state.js';

const TerminalStateContext = createContext(null);

/**
 * The transcript belongs to one session, so output from a previous session is
 * never shown as if it described the current one. Command history is kept.
 */
export function TerminalStateProvider({ children }) {
  const { session } = useSessionState();
  const sessionId = session?.id ?? null;
  const [history] = useState(createCommandHistory);
  const state = useMemo(() => createTerminalState({ history, sessionId }), [history, sessionId]);
  return <TerminalStateContext.Provider value={state}>{children}</TerminalStateContext.Provider>;
}

export function useTerminalState() {
  const state = useContext(TerminalStateContext);
  if (!state) {
    throw new Error('useTerminalState must be used inside a TerminalStateProvider.');
  }
  return state;
}
