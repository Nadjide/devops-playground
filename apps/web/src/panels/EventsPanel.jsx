import { ListTree } from 'lucide-react';
import { useSessionState } from '../session/SessionContext.jsx';
import { EmptyState } from '../components/EmptyState.jsx';
import { formatTime, sourceLabel } from '../components/format.js';

function summary(event) {
  const { payload } = event;
  if (event.type.startsWith('operation.')) {
    return `${payload.operation.type}${payload.operation.parameters.serviceId ? ` ${payload.operation.parameters.serviceId}` : ''}`;
  }
  if (event.type === 'resource.observed') {
    return [payload.state, payload.health].filter(Boolean).join(' / ');
  }
  if (event.type === 'probe.completed') {
    return `${payload.path} ${payload.ok ? payload.statusCode : 'failed'}`;
  }
  if (event.type === 'log.appended') {
    return `${payload.entries.length} line${payload.entries.length === 1 ? '' : 's'}`;
  }
  if (event.type === 'session.status-changed') {
    return payload.status;
  }
  return '';
}

/** Orchestration events, distinct from workload logs, newest first. */
export function EventsPanel() {
  const { events } = useSessionState();
  if (events.length === 0) {
    return <EmptyState icon={ListTree} title="No orchestration events yet" />;
  }
  const discarded = events[0].sequence - 1;
  return (
    <div className="events-panel">
      {discarded > 0 ? (
        <p className="truncation-note" role="note">
          Showing the latest {events.length} events; {discarded} older event{discarded === 1 ? ' was' : 's were'} discarded.
        </p>
      ) : null}
      <ol className="event-list" aria-label="Orchestration events">
        {[...events].reverse().map((event) => (
          <li key={event.id} className="event-row">
            <span className="mono small muted">{formatTime(event.occurredAt)}</span>
            <span>
              <span className="mono">{event.type}</span>
              {summary(event) ? <span className="small muted"> {summary(event)}</span> : null}
            </span>
            <span className="small muted">#{event.sequence} · gen {event.generation} · {sourceLabel(event.source)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
