import { describe, expect, it } from 'vitest';
import { createRunnerClient } from '../src/runner-client.js';

function ndjson(records) {
  const text = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  return new Response(new ReadableStream({
    start(controller) {
      // Split mid-record to prove the parser buffers partial lines.
      const bytes = new TextEncoder().encode(text);
      controller.enqueue(bytes.slice(0, 17));
      controller.enqueue(bytes.slice(17));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

describe('runner stream client', () => {
  it('forwards progress records and returns the final result with the bearer token', async () => {
    let seen;
    const client = createRunnerClient({
      url: 'http://runner:4000',
      token: 'token-0123456789abcdef0123456789abcdef',
      fetchImpl: async (url, init) => {
        seen = { url: String(url), init };
        return ndjson([{ kind: 'emit', type: 'resource.observed', payload: { resourceId: 'api-g1', state: 'running' } }, { kind: 'result', result: { ok: true } }]);
      },
    });
    const records = [];
    const outcome = await client.stream('/v1/sessions/s1/execute', { generation: 1 }, { onRecord: (record) => records.push(record) });
    expect(outcome).toEqual({ result: { ok: true } });
    expect(records).toHaveLength(1);
    expect(seen.url).toBe('http://runner:4000/v1/sessions/s1/execute');
    expect(seen.init.headers.authorization).toBe('Bearer token-0123456789abcdef0123456789abcdef');
    expect(seen.init.redirect).toBe('error');
  });

  it('returns typed failures for runner errors, outages, and truncated streams', async () => {
    const failing = createRunnerClient({ url: 'http://runner:4000', token: 't', fetchImpl: async () => ndjson([{ kind: 'failure', code: 'CONTAINER_EXITED', message: 'api exited', retryable: false }]) });
    expect(await failing.stream('/x', {})).toEqual({ failure: { code: 'CONTAINER_EXITED', message: 'api exited', retryable: false } });
    const offline = createRunnerClient({ url: 'http://runner:4000', token: 't', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    expect((await offline.stream('/x', {})).failure.code).toBe('RUNNER_UNAVAILABLE');
    const truncated = createRunnerClient({ url: 'http://runner:4000', token: 't', fetchImpl: async () => ndjson([{ kind: 'progress', line: 'building' }]) });
    expect((await truncated.stream('/x', {})).failure.code).toBe('RUNNER_STREAM_INTERRUPTED');
  });

  it('propagates cancellation to the caller', async () => {
    const controller = new AbortController();
    const client = createRunnerClient({
      url: 'http://runner:4000',
      token: 't',
      fetchImpl: async (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    });
    const pending = client.stream('/x', {}, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
  });
});
