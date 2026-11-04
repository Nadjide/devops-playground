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

  return {
    request,
    health: () => request('/v1/health'),
    docker: () => request('/v1/docker'),
  };
}
