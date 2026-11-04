/**
 * Authenticated client for the internal runner. Failures become typed results;
 * the token is sent only in the Authorization header and never logged.
 */
export function createRunnerClient({ url, token, fetchImpl = globalThis.fetch, timeoutMs = 5000 }) {
  async function request(path, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await fetchImpl(new URL(path, url), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, status: 503, error: { code: 'RUNNER_UNAVAILABLE', message: 'The local runner is not reachable.', retryable: true } };
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: payload?.error ?? payload ?? { code: 'RUNNER_ERROR', message: 'The runner returned an error.', retryable: true },
        body: payload,
      };
    }
    return { ok: true, status: response.status, body: payload };
  }

  /**
   * POST and consume an NDJSON stream. Every record is passed to `onRecord`;
   * the final `result` or `failure` record is returned. Aborting the signal
   * closes the connection, which the runner treats as cancellation.
   */
  async function stream(path, body, { signal, onRecord = () => {}, timeoutMs: limit = 120_000 } = {}) {
    const signals = [AbortSignal.timeout(limit), ...(signal ? [signal] : [])];
    let response;
    try {
      response = await fetchImpl(new URL(path, url), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      return { failure: { code: 'RUNNER_UNAVAILABLE', message: 'The local runner is not reachable.', retryable: true } };
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      return { failure: payload?.error ?? { code: 'RUNNER_ERROR', message: 'The runner rejected the request.', retryable: false } };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let final = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line.trim()) {
            continue;
          }
          const record = JSON.parse(line);
          if (record.kind === 'result') {
            final = { result: record.result };
          } else if (record.kind === 'failure') {
            final = { failure: { code: record.code, message: record.message, retryable: Boolean(record.retryable) } };
          } else {
            onRecord(record);
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      return { failure: { code: 'RUNNER_STREAM_INTERRUPTED', message: 'The runner connection was interrupted.', retryable: true } };
    }
    return final ?? { failure: { code: 'RUNNER_STREAM_INTERRUPTED', message: 'The runner ended without a result.', retryable: true } };
  }

  return {
    request,
    stream,
    health: () => request('/v1/health'),
    docker: () => request('/v1/docker'),
  };
}
