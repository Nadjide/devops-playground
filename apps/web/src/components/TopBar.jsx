import { Boxes, FlaskConical, Radio } from 'lucide-react';
import { labCatalog } from '@devops-playground/lab-core';
import { useSessionClient, useSessionState } from '../session/SessionContext.jsx';
import { SessionMenu } from './SessionMenu.jsx';

const connectionLabels = {
  connecting: 'Starting simulator',
  ready: 'Simulator ready',
  disconnected: 'Session unavailable',
};

export function TopBar() {
  const client = useSessionClient();
  const state = useSessionState();
  const labId = state.session?.labId ?? labCatalog[0].id;

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
      </div>
      <div className="chrome-actions">
        <label className="mission-select">
          <span className="visually-hidden">Mission</span>
          <select value={labId} disabled={labCatalog.length < 2} onChange={() => {}} aria-describedby="mission-select-hint">
            {labCatalog.map((lab) => <option key={lab.id} value={lab.id}>{lab.title}</option>)}
          </select>
          <span id="mission-select-hint" className="visually-hidden">Selected mission</span>
        </label>
        <SessionMenu />
      </div>
    </header>
  );
}
