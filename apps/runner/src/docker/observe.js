const ZERO_TIME = '0001-01-01T00:00:00Z';

const LIFECYCLE = {
  created: 'created',
  running: 'running',
  paused: 'running',
  restarting: 'starting',
  removing: 'removing',
  dead: 'exited',
};

function isoOrNull(value) {
  if (!value || value.startsWith(ZERO_TIME.slice(0, 10))) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** Translate `docker inspect` into the domain observation (without provenance). */
export function observationFrom(info, { appPort, stoppedByRequest = true }) {
  const state = info.State ?? {};
  let lifecycle = LIFECYCLE[state.Status] ?? 'unknown';
  if (state.Status === 'exited') {
    lifecycle = state.ExitCode === 0 && stoppedByRequest ? 'stopped' : 'exited';
  }
  const health = { healthy: 'healthy', unhealthy: 'unhealthy', starting: 'starting' }[state.Health?.Status] ?? 'unknown';
  return {
    state: lifecycle,
    health: lifecycle === 'running' || lifecycle === 'exited' ? health : 'unknown',
    image: info.Config?.Image ?? null,
    exitCode: ['stopped', 'exited'].includes(lifecycle) ? (state.ExitCode ?? null) : null,
    startedAt: lifecycle === 'created' ? null : isoOrNull(state.StartedAt),
    ports: [{ containerPort: appPort, hostPort: null }],
    unavailableReason: null,
  };
}

/** Split Docker's multiplexed log stream (non-TTY) into stdout/stderr records. */
export function demultiplex(buffer) {
  const records = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const stream = buffer[offset] === 2 ? 'stderr' : 'stdout';
    const size = buffer.readUInt32BE(offset + 4);
    const text = buffer.subarray(offset + 8, offset + 8 + size).toString('utf8');
    offset += 8 + size;
    for (const line of text.split('\n')) {
      if (line.trim()) {
        records.push({ stream, line });
      }
    }
  }
  return records;
}

/**
 * Read container log lines newer than `cursor` (Docker's nanosecond timestamp).
 * Returns domain log lines plus the new cursor.
 */
export async function readContainerLogs(container, { serviceId, cursor = null, tail = 200 }) {
  const raw = await container.logs({ stdout: true, stderr: true, timestamps: true, tail, follow: false });
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  let next = cursor;
  const lines = [];
  for (const { stream, line } of demultiplex(buffer)) {
    const space = line.indexOf(' ');
    const stamp = line.slice(0, space);
    if (cursor && stamp <= cursor) {
      continue;
    }
    next = stamp;
    const at = Number.isNaN(Date.parse(stamp)) ? new Date().toISOString() : new Date(Date.parse(stamp)).toISOString();
    lines.push({ serviceId, stream, level: stream === 'stderr' ? 'error' : 'info', message: line.slice(space + 1), at });
  }
  return { lines, cursor: next };
}
