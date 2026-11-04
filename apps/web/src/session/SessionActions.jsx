import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { useOperationDispatch } from './operations.js';

const SessionActionsContext = createContext(null);

const copy = {
  'session.reset': {
    title: 'Reset this session?',
    body: 'Active work is cancelled, session resources are recreated from the selected fixture, and current objective evidence is cleared. A new generation starts.',
    confirm: 'Reset session',
  },
  'session.end': {
    title: 'End this session?',
    body: 'Active work is cancelled and every resource owned by this session is removed. You can start a new session afterwards.',
    confirm: 'End session',
  },
};

/**
 * Single confirmation path for session lifecycle operations, shared by the
 * session menu and the terminal so both behave identically.
 */
export function SessionActionsProvider({ children }) {
  const dispatch = useOperationDispatch();
  const [pending, setPending] = useState(null);

  const requestLifecycle = useCallback((type, { returnFocus = null, onSettled } = {}) => {
    setPending({ type, returnFocus, onSettled });
  }, []);

  const value = useMemo(() => ({ requestLifecycle }), [requestLifecycle]);
  const text = pending ? copy[pending.type] : null;

  return (
    <SessionActionsContext.Provider value={value}>
      {children}
      {pending ? (
        <ConfirmDialog
          title={text.title}
          confirmLabel={text.confirm}
          returnFocus={pending.returnFocus}
          onCancel={() => {
            pending.onSettled?.(null);
            setPending(null);
          }}
          onConfirm={async () => {
            const current = pending;
            setPending(null);
            // Evaluate the dispatch first: an optional call skips its arguments.
            const operation = await dispatch(current.type);
            current.onSettled?.(operation);
          }}
        >
          <p>{text.body}</p>
        </ConfirmDialog>
      ) : null}
    </SessionActionsContext.Provider>
  );
}

export function useSessionActions() {
  const value = useContext(SessionActionsContext);
  if (!value) {
    throw new Error('useSessionActions must be used inside a SessionActionsProvider.');
  }
  return value;
}
