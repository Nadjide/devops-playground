import { ListTree } from 'lucide-react';
import { useSessionState } from '../session/SessionContext.jsx';
import { EmptyState } from '../components/EmptyState.jsx';
import { formatTime, sourceLabel } from '../components/format.js';

export function EventsPanel() {
  const { events } = useSessionState();
  if (events.length === 0) {
    return <EmptyState icon={ListTree} title="No orchestration events yet" />;
  }
  return (
    <ol className="event-list" aria-label="Orchestration events">
      {[...events].reverse().map((event) => (
        <li key={event.id} className="event-row">
          <span className="mono small muted">{formatTime(event.occurredAt)}</span>
          <span className="mono">{event.type}</span>
          <span className="small muted">#{event.sequence} · rev {event.revision} · {sourceLabel(event.source)}</span>
        </li>
      ))}
    </ol>
  );
}
