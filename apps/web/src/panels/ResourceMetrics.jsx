import { useEffect, useState } from 'react';
import { Cpu, MemoryStick } from 'lucide-react';
import { useSessionClient, useSessionState } from '../session/SessionContext.jsx';
import { ObservationAge } from '../components/ObservationAge.jsx';

const POLL_MS = 5000;
const mib = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

/**
 * Measured CPU and memory for Local Docker workloads. Nothing is shown as a
 * number unless Docker returned a measurement; failures stay visible.
 */
export function ResourceMetrics() {
  const client = useSessionClient();
  const { session } = useSessionState();
  const [state, setState] = useState({ status: 'loading', samples: [], error: null });
  const active = session?.status === 'active';
  const sessionKey = `${session?.id}:${session?.generation}`;

  useEffect(() => {
    if (!client.metrics || !active) {
      return undefined;
    }
    let cancelled = false;
    async function poll() {
      try {
        const result = await client.metrics();
        if (!cancelled && result) {
          setState({ status: 'ready', samples: result.samples, error: null });
        }
      } catch (error) {
        if (!cancelled) {
          setState((current) => ({ ...current, status: 'error', error: error.message }));
        }
      }
    }
    poll();
    const handle = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [client, active, sessionKey]);

  if (!client.metrics) {
    return null;
  }

  return (
    <section className="resource-metrics" aria-label="Measured resource usage">
      <h3 className="section-label">Measured resource usage (Docker)</h3>
      {state.status === 'loading' ? <p className="small muted" role="status">Measuring…</p> : null}
      {state.status === 'error' ? <p className="small field-error" role="status">Metrics unavailable: {state.error}</p> : null}
      <div className="metric-grid">
        {state.samples.map((sample) => (sample.available ? (
          <article key={sample.serviceId} className="metric-card" aria-label={`${sample.serviceId} resource usage`}>
            <h3><Cpu aria-hidden="true" size={15} /> {sample.serviceId} CPU</h3>
            <p className="metric-value">{sample.cpuPercent.toFixed(2)} %</p>
            <h3><MemoryStick aria-hidden="true" size={15} /> Memory</h3>
            <p className="metric-value">{mib(sample.memoryBytes)}</p>
            {sample.memoryLimitBytes ? (
              <div className="metric-bar" role="img" aria-label={`${Math.round((sample.memoryBytes / sample.memoryLimitBytes) * 100)} percent of the ${mib(sample.memoryLimitBytes)} limit`}>
                <span style={{ width: `${Math.min(100, (sample.memoryBytes / sample.memoryLimitBytes) * 100)}%` }} />
              </div>
            ) : null}
            <p className="small muted">
              limit {sample.memoryLimitBytes ? mib(sample.memoryLimitBytes) : 'unknown'}
              {sample.pids !== null ? ` · ${sample.pids} processes` : ''} · <ObservationAge at={sample.observedAt} /> · Docker
            </p>
          </article>
        ) : (
          <article key={sample.serviceId} className="metric-card" aria-label={`${sample.serviceId} resource usage`}>
            <h3><Cpu aria-hidden="true" size={15} /> {sample.serviceId}</h3>
            <p className="metric-value">Unavailable</p>
            <p className="small muted">{sample.reason} · <ObservationAge at={sample.observedAt} /></p>
          </article>
        )))}
      </div>
    </section>
  );
}
