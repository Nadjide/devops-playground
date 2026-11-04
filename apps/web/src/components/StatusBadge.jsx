const tones = {
  running: 'success', healthy: 'success', passed: 'success', satisfied: 'success', ready: 'success', completed: 'success',
  starting: 'warning', created: 'warning', removing: 'warning', queued: 'warning', pending: 'neutral', 'in-progress': 'info',
  stopped: 'neutral', exited: 'danger', unhealthy: 'danger', failed: 'danger', invalidated: 'danger', removed: 'neutral',
  unknown: 'neutral', skipped: 'neutral', cancelled: 'neutral', disconnected: 'danger', connecting: 'warning',
};

export function StatusBadge({ value, label = value, prefix = null }) {
  const tone = tones[value] ?? 'neutral';
  return (
    <span className={`badge badge-${tone}`}>
      <span className="badge-dot" aria-hidden="true" />
      {prefix ? <span className="visually-hidden">{prefix} </span> : null}
      {label}
    </span>
  );
}
