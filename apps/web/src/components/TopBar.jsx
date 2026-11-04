import { useRef } from 'react';
import { Boxes, FlaskConical, Radio, Save, SaveOff } from 'lucide-react';
import { useSessionClient, useSessionState } from '../session/SessionContext.jsx';
import { useSessionActions } from '../session/SessionActions.jsx';
import { SessionMenu } from './SessionMenu.jsx';

const connectionLabels = {
  connecting: 'Starting simulator',
  ready: 'Simulator ready',
  disconnected: 'Session unavailable',
};

const persistenceLabels = {
  idle: 'Not saved yet',
  saved: 'Progress saved locally',
  paused: 'Saving paused',
  unavailable: 'Progress not saved',
};

function PersistenceIndicator({ persistence }) {
  if (!persistence) {
    return null;
  }
  const Icon = persistence.status === 'saved' || persistence.status === 'idle' ? Save : SaveOff;
  return (
    <span className={`persistence persistence-${persistence.status}`} title={persistence.message ?? 'Demo progress is kept in this browser only.'}>
      <Icon aria-hidden="true" size={13} />
      {persistenceLabels[persistence.status]}
    </span>
  );
}

export function TopBar() {
  const client = useSessionClient();
  const state = useSessionState();
  const { requestSessionChange } = useSessionActions();
  const selectRef = useRef(null);
  const labId = state.session?.labId ?? client.selection().labId;

  return (
    <header className="topbar">
      <div className="brand">
        <Boxes aria-hidden="true" size={22} className="brand-icon" />
        <h1>DevOps Playground</h1>
      </div>
      <div className="chrome-status" aria-label="Session status">
        <span className="mode-pill" title={`Execution backend: ${client.capabilities.backend}`}>
          <FlaskConical aria-hidden="true" size={14} />
          <span>Demo mode</span>
          <span className="mode-detail">simulated</span>
        </span>
        <span className={`connection connection-${state.connection}`} role="status">
          <Radio aria-hidden="true" size={14} />
          {connectionLabels[state.connection] ?? state.connection}
        </span>
        <PersistenceIndicator persistence={state.persistence} />
      </div>
      <div className="chrome-actions">
        <label className="mission-select">
          <span className="visually-hidden">Mission</span>
          <select
            ref={selectRef}
            value={labId}
            disabled={state.status === 'loading'}
            onChange={(event) => {
              // The select keeps the active lab until the change is confirmed.
              requestSessionChange({ labId: event.target.value }, { returnFocus: selectRef.current });
            }}
          >
            {client.labs.map((lab) => <option key={lab.id} value={lab.id}>{lab.title}</option>)}
          </select>
        </label>
        <SessionMenu />
      </div>
    </header>
  );
}
