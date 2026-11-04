import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Eraser, Pause, Play, RefreshCw, ScrollText } from 'lucide-react';
import { useSessionClient, useSessionState } from '../session/SessionContext.jsx';
import { isActive, useOperationDispatch } from '../session/operations.js';
import { EmptyState } from '../components/EmptyState.jsx';
import { formatTime, sourceLabel } from '../components/format.js';

const READ_TAIL = 200;

export function LogsPanel() {
  const client = useSessionClient();
  const { session } = useSessionState();
  const dispatch = useOperationDispatch();
  const [service, setService] = useState('all');
  const [paused, setPaused] = useState(false);
  const [clearedAfter, setClearedAfter] = useState(0);
  const listRef = useRef(null);
  const readKey = useRef(null);

  const services = session.resources.map((resource) => resource.serviceId);
  const targets = service === 'all' ? services : [service];
  const canRead = client.isAvailable('container.logs') && session.status === 'active';
  const reading = session.operations.some((operation) => operation.type === 'container.logs' && isActive(operation));
  const visible = session.logs.entries.filter((entry) => (service === 'all' || entry.serviceId === service || entry.serviceId === null) &&
    entry.seq > clearedAfter);
  const hidden = session.logs.entries.length > 0 && clearedAfter > 0;

  const read = () => {
    for (const serviceId of targets) {
      dispatch('container.logs', { serviceId, tail: READ_TAIL });
    }
  };

  // Opening the viewer reads the logs; that read is the diagnostic evidence.
  useEffect(() => {
    const key = `${session.generation}:${service}`;
    if (canRead && readKey.current !== key) {
      readKey.current = key;
      for (const serviceId of service === 'all' ? services : [service]) {
        dispatch('container.logs', { serviceId, tail: READ_TAIL });
      }
    }
  }, [canRead, dispatch, service, services, session.generation]);

  useLayoutEffect(() => {
    if (!paused && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [paused, visible.length]);

  return (
    <div className="logs-panel">
      <div className="logs-toolbar">
        <label className="field-inline">
          <span>Service</span>
          <select value={service} onChange={(event) => setService(event.target.value)}>
            <option value="all">All services</option>
            {services.map((serviceId) => <option key={serviceId} value={serviceId}>{serviceId}</option>)}
          </select>
        </label>
        <button type="button" className="button" aria-disabled={!canRead || reading || undefined} onClick={() => canRead && !reading && read()}>
          <RefreshCw aria-hidden="true" size={14} /> Read logs
        </button>
        <button type="button" className="button" aria-pressed={paused} onClick={() => setPaused((value) => !value)}>
          {paused ? <Play aria-hidden="true" size={14} /> : <Pause aria-hidden="true" size={14} />}
          {paused ? 'Resume autoscroll' : 'Pause autoscroll'}
        </button>
        <button
          type="button"
          className="button"
          onClick={() => setClearedAfter(session.logs.entries.at(-1)?.seq ?? 0)}
          aria-disabled={visible.length === 0 || undefined}
        >
          <Eraser aria-hidden="true" size={14} /> Clear view
        </button>
      </div>

      {session.logs.dropped > 0 ? (
        <p className="truncation-note" role="note">
          {session.logs.dropped} older entr{session.logs.dropped === 1 ? 'y was' : 'ies were'} discarded by the retention limit.
        </p>
      ) : null}
      {hidden ? (
        <p className="small muted">
          View cleared. Domain logs are kept.{' '}
          <button type="button" className="link-button" onClick={() => setClearedAfter(0)}>Show all entries</button>
        </p>
      ) : null}

      {visible.length === 0 ? (
        <EmptyState icon={ScrollText} title="No workload log entries to show">
          {hidden ? 'New entries appear here as the workload writes them.' : 'Read the logs to load the service output.'}
        </EmptyState>
      ) : (
        <ol ref={listRef} className="log-list" aria-label="Workload log entries" tabIndex={0}>
          {visible.map((entry) => (
            <li key={entry.seq} className={`log-entry log-${entry.stream}`}>
              <span className="log-meta mono">{formatTime(entry.at)}</span>
              <span className="log-meta">
                {entry.serviceId ?? 'system'} · {entry.stream}{entry.level !== 'info' ? ` · ${entry.level}` : ''} · {sourceLabel(entry.source)}
              </span>
              <span className="log-message mono">{entry.message}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
