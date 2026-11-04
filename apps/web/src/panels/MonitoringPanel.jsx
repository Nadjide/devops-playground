import { Activity, HeartPulse, Stethoscope, Tag } from 'lucide-react';
import { useSessionClient, useSessionState } from '../session/SessionContext.jsx';
import { isActive, useOperationDispatch } from '../session/operations.js';
import { EmptyState } from '../components/EmptyState.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { RecentOperations } from '../components/RecentOperations.jsx';
import { formatTime, sourceLabel } from '../components/format.js';
import { ObservationAge } from '../components/ObservationAge.jsx';

function probeOutcome(probe) {
  return probe.ok ? `HTTP ${probe.statusCode}` : (probe.statusCode ? `HTTP ${probe.statusCode}` : probe.error);
}

export function MonitoringPanel() {
  const client = useSessionClient();
  const { session } = useSessionState();
  const dispatch = useOperationDispatch();
  const api = session?.resources.find((resource) => resource.serviceId === 'api');
  const probes = session?.probes ?? [];
  const health = probes.findLast((probe) => probe.kind === 'health') ?? null;
  const version = probes.findLast((probe) => probe.kind === 'version' && probe.ok) ?? null;
  const probing = (type) => (session?.operations ?? []).some((operation) => operation.type === type && isActive(operation));

  const controls = [
    { type: 'health.probe', label: 'Probe /health', path: '/health', icon: Stethoscope },
    { type: 'version.probe', label: 'Probe /version', path: '/version', icon: Tag },
  ];

  return (
    <div className="monitoring-panel">
      {api ? (
        <div className="probe-controls" role="group" aria-label="Workload probes">
          {controls.map((control) => {
            const available = client.isAvailable(control.type);
            const Icon = control.icon;
            return (
              <button
                key={control.type}
                type="button"
                className="button"
                aria-disabled={!available || probing(control.type) || undefined}
                aria-busy={probing(control.type) || undefined}
                data-tooltip={available ? `GET http://${api.serviceId}:${api.desired.expectedProbePort}${control.path}` : 'Unavailable in this session'}
                onClick={() => {
                  if (available && !probing(control.type)) {
                    dispatch(control.type, { serviceId: api.serviceId });
                  }
                }}
              >
                <Icon aria-hidden="true" size={14} /> {control.label}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="metric-grid">
        <article className="metric-card" aria-label="Workload availability">
          <h3><HeartPulse aria-hidden="true" size={15} /> Workload availability</h3>
          {health ? (
            <>
              <p className="metric-value"><StatusBadge value={health.ok ? 'healthy' : 'unhealthy'} label={health.ok ? 'Available' : 'Unavailable'} /></p>
              <p className="muted small">{probeOutcome(health)} · <ObservationAge at={health.observedAt} /> · {sourceLabel(health.source)}</p>
            </>
          ) : (
            <>
              <p className="metric-value">Unknown</p>
              <p className="muted small">No workload probe has been recorded.</p>
            </>
          )}
        </article>
        <article className="metric-card" aria-label="Last health response">
          <h3><Activity aria-hidden="true" size={15} /> Last health response</h3>
          {health?.body ? (
            <pre className="json-preview">{JSON.stringify(health.body, null, 2)}</pre>
          ) : (
            <p className="metric-value">{health ? 'No response' : 'None'}</p>
          )}
          <p className="muted small">GET /health on port {api?.desired.expectedProbePort ?? 'n/a'}.</p>
        </article>
        <article className="metric-card" aria-label="Observed version">
          <h3><Tag aria-hidden="true" size={15} /> Observed version</h3>
          <p className="metric-value mono">{version ? version.body.version : 'Unavailable'}</p>
          <p className="muted small">{version ? <><ObservationAge at={version.observedAt} /> · {sourceLabel(version.source)}</> : 'Read from GET /version once probed.'}</p>
        </article>
      </div>

      {api ? (
        <p className="small muted">
          Container healthcheck: <StatusBadge value={api.observed.health} /> · snapshot revision {session.revision}.
          The management interface health is separate from workload health.
        </p>
      ) : null}

      <h3 className="section-label">Probe history</h3>
      {probes.length === 0 ? (
        <EmptyState title="No probe results yet">Run a health or version probe to record evidence.</EmptyState>
      ) : (
        <ol className="probe-list" aria-label="Probe history">
          {[...probes].reverse().map((probe) => (
            <li key={probe.eventId} className="probe-row">
              <StatusBadge value={probe.ok ? 'passed' : 'failed'} label={probe.ok ? 'ok' : 'failed'} />
              <span className="mono">GET :{probe.port}{probe.path}</span>
              <span className="small">{probeOutcome(probe)}</span>
              <span className="small muted">{probe.durationMs} ms · {formatTime(probe.observedAt)} · {sourceLabel(probe.source)}</span>
            </li>
          ))}
        </ol>
      )}
      <RecentOperations types={['health.probe', 'version.probe']} label="Recent probes" limit={3} />
    </div>
  );
}
