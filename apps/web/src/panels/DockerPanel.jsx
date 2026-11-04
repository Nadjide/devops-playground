import { Container, Play, RotateCw, ScrollText, Search, Square } from 'lucide-react';
import { useSessionClient, useSessionState } from '../session/SessionContext.jsx';
import { IconButton } from '../components/IconButton.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { EmptyState } from '../components/EmptyState.jsx';
import { formatTime, sourceLabel } from '../components/format.js';

const actions = [
  { type: 'container.start', label: 'Start', icon: Play, tone: 'success' },
  { type: 'container.stop', label: 'Stop', icon: Square, tone: 'danger' },
  { type: 'container.restart', label: 'Restart', icon: RotateCw },
  { type: 'container.inspect', label: 'Inspect', icon: Search },
  { type: 'container.logs', label: 'Logs', icon: ScrollText },
];

export function DockerPanel() {
  const client = useSessionClient();
  const { session } = useSessionState();
  const resources = session?.resources ?? [];

  if (resources.length === 0) {
    return <EmptyState icon={Container} title="No containers in this session" />;
  }

  return (
    <ul className="resource-list" aria-label="Session containers">
      {resources.map((resource) => (
        <li key={resource.id} className="resource-row">
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
                unavailableReason={client.isAvailable(action.type) ? null : 'unavailable in this session'}
              />
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}
