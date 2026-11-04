import { useNow } from '../hooks/useNow.js';
import { formatTime } from './format.js';

export const STALE_AFTER_MS = 30_000;

function age(ms) {
  if (ms < 5_000) {
    return 'just now';
  }
  if (ms < 60_000) {
    return `${Math.round(ms / 1000)} s ago`;
  }
  if (ms < 3_600_000) {
    return `${Math.round(ms / 60_000)} min ago`;
  }
  return `${Math.round(ms / 3_600_000)} h ago`;
}

/** Observation time with relative age and an explicit stale marker. */
export function ObservationAge({ at }) {
  const now = useNow();
  if (!at) {
    return <span>never</span>;
  }
  const elapsed = Math.max(0, now - Date.parse(at));
  const stale = elapsed > STALE_AFTER_MS;
  return (
    <span title={formatTime(at)}>
      {age(elapsed)}
      {stale ? <span className="stale-tag">stale</span> : null}
    </span>
  );
}
