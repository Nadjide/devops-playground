import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { getLabManifest } from '@devops-playground/lab-core';
import { ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { useOperationDispatch } from './operations.js';
import { useSessionClient } from './SessionContext.jsx';

const SessionActionsContext = createContext(null);

const lifecycleCopy = {
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

function switchCopy({ labId, fixtureLabel }) {
  const lab = getLabManifest(labId);
  return {
    title: 'Start a new session?',
    body: `Switching to “${lab.title}”${fixtureLabel ? ` with the “${fixtureLabel}” fixture` : ''} replaces the current session. Its resources are discarded and its progress is not kept.`,
    confirm: 'Start new session',
    tone: 'primary',
  };
}

/**
 * Single confirmation path for session lifecycle and session changes, shared
 * by the session menu, mission selector, and terminal so all behave alike.
 */
export function SessionActionsProvider({ children }) {
  const client = useSessionClient();
  const dispatch = useOperationDispatch();
  const [pending, setPending] = useState(null);

  const requestLifecycle = useCallback((type, { returnFocus = null, onSettled } = {}) => {
    setPending({ kind: 'lifecycle', type, returnFocus, onSettled, copy: lifecycleCopy[type] });
  }, []);

  const requestSessionChange = useCallback((target, { returnFocus = null, onSettled } = {}) => {
    setPending({ kind: 'switch', target, returnFocus, onSettled, copy: switchCopy(target) });
  }, []);

  const value = useMemo(() => ({ requestLifecycle, requestSessionChange }), [requestLifecycle, requestSessionChange]);

  async function confirm() {
    const current = pending;
    setPending(null);
    if (current.kind === 'switch') {
      await client.startSession({ labId: current.target.labId, fixtureId: current.target.fixtureId ?? null });
      current.onSettled?.(true);
      return;
    }
    // Evaluate the dispatch first: an optional call skips its arguments.
    const operation = await dispatch(current.type);
    current.onSettled?.(operation);
  }

  return (
    <SessionActionsContext.Provider value={value}>
      {children}
      {pending ? (
        <ConfirmDialog
          title={pending.copy.title}
          confirmLabel={pending.copy.confirm}
          tone={pending.copy.tone ?? 'danger'}
          returnFocus={pending.returnFocus}
          onCancel={() => {
            pending.onSettled?.(null);
            setPending(null);
          }}
          onConfirm={confirm}
        >
          <p>{pending.copy.body}</p>
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
