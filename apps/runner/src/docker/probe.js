export const PROBE_LIMITS = Object.freeze({ timeoutMs: 5000, bodyBytes: 16 * 1024 });
// The storage check makes two storage requests inside the workload, so it gets a longer deadline.
const PATHS = { health: '/health', version: '/version', 'storage-check': '/storage-check' };
const TIMEOUTS = { health: PROBE_LIMITS.timeoutMs, version: PROBE_LIMITS.timeoutMs, 'storage-check': 15_000 };
const ALIAS = /^[a-z][a-z0-9-]{0,62}$/;

async function readBounded(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) {
    return { text: '', truncated: false };
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return { text: '', truncated: true };
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated: false };
}

function describe(error, target, timeoutMs) {
  const code = error?.cause?.code ?? error?.code;
  if (error?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return `probe timed out after ${timeoutMs} ms (${target})`;
  }
  if (code) {
    return `connect ${code} ${target}`;
  }
  return `probe failed (${target})`;
}

/**
 * HTTP probe of a fixed service alias, approved port, and fixed path on the
 * session network. Redirects are never followed and bodies are bounded.
 */
export async function probeService({ serviceId, kind, port, fetchImpl = globalThis.fetch }) {
  if (!ALIAS.test(serviceId) || !Number.isInteger(port) || port < 1024 || port > 65535 || !PATHS[kind]) {
    throw new Error('Probe target is not approved.');
  }
  const path = PATHS[kind];
  const target = `${serviceId}:${port}`;
  const started = Date.now();
  const base = { serviceId, kind, port, path };
  try {
    const response = await fetchImpl(`http://${target}${path}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUTS[kind]),
      headers: { accept: 'application/json' },
    });
    const durationMs = Date.now() - started;
    if (response.status >= 300 && response.status < 400) {
      return { ...base, ok: false, statusCode: response.status, body: null, error: 'Redirects are not followed by workbench probes.', durationMs };
    }
    const { text, truncated } = await readBounded(response, PROBE_LIMITS.bodyBytes);
    if (truncated) {
      return { ...base, ok: false, statusCode: response.status, body: null, error: 'Probe response exceeded 16 KiB.', durationMs };
    }
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    // The storage check answers 503 with a structured body when storage fails.
    const ok = response.status === 200 && body !== null;
    return {
      ...base, ok, statusCode: response.status, body,
      error: ok ? null : (body === null ? 'Response was not JSON.' : `HTTP ${response.status}`),
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return { ...base, ok: false, statusCode: null, body: null, error: describe(error, target, TIMEOUTS[kind]), durationMs: Date.now() - started };
  }
}
