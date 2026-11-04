import { createContext, useContext, useState } from 'react';
import { createTerminalState } from './state.js';

const TerminalStateContext = createContext(null);

export function TerminalStateProvider({ children }) {
  const [state] = useState(createTerminalState);
  return <TerminalStateContext.Provider value={state}>{children}</TerminalStateContext.Provider>;
}

export function useTerminalState() {
  const state = useContext(TerminalStateContext);
  if (!state) {
    throw new Error('useTerminalState must be used inside a TerminalStateProvider.');
  }
  return state;
}
