import { Activity, HeartPulse, Tag } from 'lucide-react';
import { EmptyState } from '../components/EmptyState.jsx';

export function MonitoringPanel() {
  return (
    <div className="monitoring-panel">
      <div className="metric-grid">
        <article className="metric-card">
          <h3><HeartPulse aria-hidden="true" size={15} /> Workload availability</h3>
          <p className="metric-value">Unknown</p>
          <p className="muted small">No workload probe has been recorded.</p>
        </article>
        <article className="metric-card">
          <h3><Activity aria-hidden="true" size={15} /> Last health response</h3>
          <p className="metric-value">None</p>
          <p className="muted small">GET /health on the expected probe port.</p>
        </article>
        <article className="metric-card">
          <h3><Tag aria-hidden="true" size={15} /> Observed version</h3>
          <p className="metric-value">Unavailable</p>
          <p className="muted small">Read from GET /version once probed.</p>
        </article>
      </div>
      <h3 className="section-label">Probe history</h3>
      <EmptyState title="No probe results yet">
        The management interface health is separate from workload health.
      </EmptyState>
    </div>
  );
}
