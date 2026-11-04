import { useState } from 'react';
import { Container, LoaderCircle, Play, RotateCw, ScrollText, Search, Square, X } from 'lucide-react';
import { useSessionClient, useSessionState } from '../session/SessionContext.jsx';
import {
  describeOperation, isActive, latestSucceeded, useOperationDispatch, useServiceOperations,
} from '../session/operations.js';
import { IconButton } from '../components/IconButton.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { EmptyState } from '../components/EmptyState.jsx';
import { RecentOperations } from '../components/RecentOperations.jsx';
import { formatTime, sourceLabel } from '../components/format.js';

const actions = [
  { type: 'container.start', label: 'Start', icon: Play, tone: 'success' },
  { type: 'container.stop', label: 'Stop', icon: Square, tone: 'danger' },
  { type: 'container.restart', label: 'Restart', icon: RotateCw },
  { type: 'container.inspect', label: 'Inspect', icon: Search },
  { type: 'container.logs', label: 'Read logs of', icon: ScrollText, parameters: { tail: 50 } },
];

const DOCKER_TYPES = actions.map((action) => action.type);

function InspectDetails({ operation, onClose }) {
  const { configuration, observed } = operation.result;
  return (
    <section className="inspect" aria-label={`Inspect result for ${operation.result.serviceId}`}>
      <header className="inspect-head">
        <h3>Inspect {operation.result.serviceId}</h3>
        <span className="muted small">captured {formatTime(operation.finishedAt)}</span>
        <IconButton icon={X} label="Close inspect result" onClick={onClose} />
      </header>
      <div className="inspect-grid">
        <dl>
          <dt>Approved configuration</dt>
          <dd><span className="muted">image</span> <span className="mono">{configuration.image}</span></dd>
          <dd><span className="muted">appPort</span> <span className="mono">{configuration.appPort}</span></dd>
          <dd><span className="muted">expectedProbePort</span> <span className="mono">{configuration.expectedProbePort}</span> <span className="muted small">(read-only)</span></dd>
        </dl>
        <dl>
          <dt>Observed</dt>
          <dd><span className="muted">state</span> {observed.state}{observed.exitCode !== null ? ` (exit ${observed.exitCode})` : ''}</dd>
          <dd><span className="muted">health</span> {observed.health}</dd>
          <dd><span className="muted">started</span> {formatTime(observed.startedAt)}</dd>
          <dd><span className="muted">ports</span> <span className="mono">{observed.ports.map((port) => port.containerPort).join(', ') || 'none'}</span></dd>
          <dd><span className="muted">source</span> {sourceLabel(observed.source)}</dd>
        </dl>
      </div>
    </section>
  );
}

function ResourceRow({ resource }) {
  const client = useSessionClient();
  const dispatch = useOperationDispatch();
  const operations = useServiceOperations(resource.serviceId);
  const [closedInspect, setClosedInspect] = useState(null);
  const pending = operations.filter(isActive);
  const inspect = latestSucceeded(operations, 'container.inspect');
  const logs = latestSucceeded(operations, 'container.logs');

  return (
    <li className="resource-row">
      <div className="resource-name">
        <Container aria-hidden="true" size={18} />
        <div>
          <p className="resource-service">{resource.serviceId}</p>
          <p className="mono muted small">{resource.observed.image ?? resource.desired.image}</p>
        </div>
      </div>
      <dl className="resource-facts">
        <div><dt>State</dt><dd><StatusBadge value={resource.observed.state} /></dd></div>
        <div><dt>Health</dt><dd><StatusBadge value={resource.observed.health} /></dd></div>
        <div><dt>App port</dt><dd className="mono">{resource.desired.appPort}</dd></div>
        <div>
          <dt>Observed</dt>
          <dd className="small">{formatTime(resource.observed.observedAt)} · {sourceLabel(resource.observed.source)}</dd>
        </div>
      </dl>
      <div className="resource-actions" role="group" aria-label={`${resource.serviceId} actions`}>
        {actions.map((action) => (
          <IconButton
            key={action.type}
            icon={action.icon}
            label={`${action.label} ${resource.serviceId}`}
            tone={action.tone}
            busy={pending.some((operation) => operation.type === action.type)}
            unavailableReason={client.isAvailable(action.type) ? null : 'unavailable in this session'}
            onClick={() => {
              setClosedInspect(null);
              dispatch(action.type, { serviceId: resource.serviceId, ...action.parameters });
            }}
          />
        ))}
      </div>
      {pending.length > 0 ? (
        <p className="pending-note" role="status">
          <LoaderCircle aria-hidden="true" size={14} className="spin" />
          {pending.map((operation) => `${describeOperation(operation)} (${operation.status})`).join(', ')}
        </p>
      ) : null}
      {logs ? (
        <p className="small muted resource-note">
          Read {logs.result.count} log line{logs.result.count === 1 ? '' : 's'} at {formatTime(logs.finishedAt)}.
        </p>
      ) : null}
      {inspect && closedInspect !== inspect.id ? (
        <InspectDetails operation={inspect} onClose={() => setClosedInspect(inspect.id)} />
      ) : null}
    </li>
  );
}

export function DockerPanel() {
  const { session } = useSessionState();
  const resources = session?.resources ?? [];

  if (resources.length === 0) {
    return <EmptyState icon={Container} title="No containers in this session" />;
  }

  return (
    <div className="docker-panel">
      <ul className="resource-list" aria-label="Session containers">
        {resources.map((resource) => <ResourceRow key={resource.id} resource={resource} />)}
      </ul>
      <p className="small muted">Snapshot revision {session.revision} · generation {session.generation}</p>
      <RecentOperations types={DOCKER_TYPES} label="Recent container operations" />
    </div>
  );
}
