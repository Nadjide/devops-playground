import { describe, expect, it } from 'vitest';
import {
  createSimulatorExecutor, DomainError, LIMITS, RUNTIME_LIMITS, SIMULATED_TIMINGS,
} from '../src/index.js';
import { appendLogEntries, emptyLogBuffer } from '../src/schemas/observations.js';
import { startRuntime } from './runtime-helpers.js';

function expectDomainError(callback, code, status) {
  let caught;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  expect(caught).toMatchObject({ code, status });
}

describe('lab runtime startup', () => {
  it('activates the fixture with simulated provenance and prior log history', async () => {
    const { runtime, api, valid } = await startRuntime();
    const session = valid();
    expect(session).toMatchObject({ status: 'active', generation: 1, mode: 'demo' });
    expect(api().observed).toMatchObject({ state: 'stopped', exitCode: 0, source: 'simulator' });
    expect(session.logs.entries.map((entry) => entry.message)).toEqual([
      '> devops-playground@1.0.0 start',
      'Configuration loaded: APP_PORT=3000',
      'DevOps Playground API 1.0.0 listening on port 3000',
      'Received SIGTERM, closing HTTP server',
      'HTTP server closed, exiting with code 0',
    ]);
    expect(runtime.getEvents().map((event) => event.type)).toEqual(['session.status-changed', 'log.appended']);
    expect(runtime.capabilities()).toContain('container.start');
  });
});

describe('simulated container lifecycle', () => {
  it('reports pending work before observing a running and healthy container', async () => {
    const { runtime, clock, submit, api, valid } = await startRuntime();
    const queued = submit('container.start', { serviceId: 'api' });
    expect(queued.status).toBe('queued');
    expect(api().observed.state).toBe('stopped');

    await clock.advance(0);
    expect(runtime.getOperation(queued.id).status).toBe('running');
    expect(api().observed.state).toBe('starting');

    await clock.advance(SIMULATED_TIMINGS.startup);
    expect(api().observed).toMatchObject({ state: 'running', health: 'starting' });
    expect(runtime.getOperation(queued.id)).toMatchObject({ status: 'succeeded', result: { state: 'running', changed: true } });

    await clock.advance(SIMULATED_TIMINGS.healthcheck);
    expect(api().observed.health).toBe('healthy');
    expect(valid().logs.entries.at(-1).message).toBe('DevOps Playground API 1.0.0 listening on port 3000');
    expect(runtime.getEvents().every((event) => event.source === 'simulator')).toBe(true);
  });

  it('records a failed health probe while the service is stopped', async () => {
    const { run, valid } = await startRuntime();
    const operation = await run('health.probe', { serviceId: 'api' });
    expect(operation).toMatchObject({
      status: 'failed',
      error: { code: 'PROBE_FAILED', retryable: true },
    });
    expect(valid().probes).toHaveLength(1);
    expect(valid().probes[0]).toMatchObject({
      kind: 'health', port: 3000, path: '/health', ok: false, statusCode: null,
      error: 'connect ECONNREFUSED api:3000', source: 'simulator', operationId: operation.id,
    });
  });

  it('returns the expected health and version bodies after start', async () => {
    const { run, valid } = await startRuntime();
    await run('container.start', { serviceId: 'api' });
    const health = await run('health.probe', { serviceId: 'api' });
    const version = await run('version.probe', { serviceId: 'api' });
    expect(health).toMatchObject({ status: 'succeeded', result: { ok: true, statusCode: 200 } });
    expect(health.result.body).toMatchObject({ status: 'ok', service: 'devops-playground' });
    expect(health.result.body.uptime).toBeGreaterThanOrEqual(0);
    expect(version.result.body).toEqual({ name: 'devops-playground', version: '1.0.0', environment: 'production' });
    expect(valid().probes.map((probe) => probe.ok)).toEqual([true, true]);
  });

  it('stops gracefully and records shutdown logs and exit code', async () => {
    const { run, api, valid } = await startRuntime();
    await run('container.start', { serviceId: 'api' });
    const stop = await run('container.stop', { serviceId: 'api' });
    expect(stop.result).toEqual({ serviceId: 'api', state: 'stopped', exitCode: 0, changed: true });
    expect(api().observed).toMatchObject({ state: 'stopped', exitCode: 0, health: 'unknown' });
    expect(valid().logs.entries.at(-2).message).toBe('Received SIGTERM, closing HTTP server');
    expect((await run('container.stop', { serviceId: 'api' })).result.changed).toBe(false);
  });

  it('inspects configuration and reads a bounded log tail as evidence', async () => {
    const { run } = await startRuntime();
    const inspect = await run('container.inspect', { serviceId: 'api' });
    expect(inspect.result).toMatchObject({
      serviceId: 'api',
      configuration: { image: 'devops-playground-lab/api:1.0.0', appPort: 3000, expectedProbePort: 3000 },
      observed: { state: 'stopped', source: 'simulator' },
    });
    const logs = await run('container.logs', { serviceId: 'api', tail: 2 });
    expect(logs.result).toEqual({ serviceId: 'api', tail: 2, count: 2, firstSeq: 4, lastSeq: 5, truncated: false });
  });

  it('serializes concurrent mutations into one coherent final state', async () => {
    const { runtime, clock, submit, api } = await startRuntime();
    const operations = [
      submit('container.start', { serviceId: 'api' }),
      submit('container.start', { serviceId: 'api' }),
      submit('container.stop', { serviceId: 'api' }),
      submit('container.restart', { serviceId: 'api' }),
    ];
    await clock.runAll();
    const results = operations.map((operation) => runtime.getOperation(operation.id));
    expect(results.map((operation) => operation.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded']);
    expect(results[1].result.changed).toBe(false);
    expect(api().observed.state).toBe('running');

    const mutationEvents = runtime.getEvents().filter((event) => ['operation.started', 'operation.succeeded'].includes(event.type));
    const order = mutationEvents.map((event) => `${event.type.slice(10)}:${event.operationId}`);
    expect(order).toEqual(operations.flatMap((operation) => [`started:${operation.id}`, `succeeded:${operation.id}`]));
  });

  it('does not let a stopped container report a stale healthcheck', async () => {
    const { clock, submit, api } = await startRuntime();
    submit('container.start', { serviceId: 'api' });
    await clock.advance(SIMULATED_TIMINGS.startup);
    submit('container.stop', { serviceId: 'api' });
    await clock.runAll();
    expect(api().observed).toMatchObject({ state: 'stopped', health: 'unknown' });
  });
});

describe('request validation and idempotency', () => {
  it('returns the original operation for an identical retry', async () => {
    const { runtime, submit } = await startRuntime();
    const first = submit('container.start', { serviceId: 'api' }, { key: 'retry-1' });
    const eventCount = runtime.getEvents().length;
    const retry = submit('container.start', { serviceId: 'api' }, { key: 'retry-1' });
    expect(retry.id).toBe(first.id);
    expect(runtime.getEvents()).toHaveLength(eventCount);
  });

  it('rejects a reused key with a different payload', async () => {
    const { submit } = await startRuntime();
    submit('container.start', { serviceId: 'api' }, { key: 'reused' });
    expectDomainError(() => submit('container.stop', { serviceId: 'api' }, { key: 'reused' }), 'IDEMPOTENCY_CONFLICT', 409);
  });

  it.each([
    [{ type: 'container.exec', generation: 1, parameters: { command: 'sh' } }, 'INVALID_OPERATION', 400],
    [{ type: 'service.configure', generation: 1, parameters: { serviceId: 'api', appPort: 3000 } }, 'OPERATION_NOT_ALLOWED', 422],
    [{ type: 'container.start', generation: 1, parameters: { serviceId: 'db' } }, 'UNKNOWN_SERVICE', 404],
    [{ type: 'container.start', generation: 2, parameters: { serviceId: 'api' } }, 'STALE_GENERATION', 409],
  ])('rejects invalid request %# with a typed error and unchanged state', async (request, code, status) => {
    const { runtime } = await startRuntime();
    const before = runtime.getSession();
    expectDomainError(() => runtime.submit(request, { idempotencyKey: 'key-x' }), code, status);
    expect(runtime.getSession()).toBe(before);
  });

  it('requires a safe idempotency key', async () => {
    const { runtime } = await startRuntime();
    const request = { type: 'container.start', generation: 1, parameters: { serviceId: 'api' } };
    expectDomainError(() => runtime.submit(request, {}), 'INVALID_IDEMPOTENCY_KEY', 400);
    expectDomainError(() => runtime.submit(request, { idempotencyKey: '../key' }), 'INVALID_IDEMPOTENCY_KEY', 400);
  });

  it('enforces the pending mutation bound with a capacity error', async () => {
    const { submit } = await startRuntime();
    for (let index = 0; index < RUNTIME_LIMITS.pendingMutations; index += 1) {
      submit('container.restart', { serviceId: 'api' });
    }
    expectDomainError(() => submit('container.stop', { serviceId: 'api' }), 'CAPACITY_EXCEEDED', 429);
    submit('health.probe', { serviceId: 'api' });
  });
});

describe('reset, generations, and end', () => {
  it('cancels in-flight work and ignores results from the previous generation', async () => {
    const { runtime, clock, submit, api, valid } = await startRuntime();
    const start = submit('container.start', { serviceId: 'api' });
    const queued = submit('container.stop', { serviceId: 'api' });
    await clock.advance(SIMULATED_TIMINGS.startup - 100);
    expect(api().observed.state).toBe('starting');

    const reset = submit('session.reset');
    const settled = runtime.settled(reset.id);
    await clock.runAll();
    expect(await settled).toMatchObject({ status: 'succeeded', result: { generation: 2 } });
    expect(runtime.getOperation(start.id).status).toBe('cancelled');
    expect(runtime.getOperation(queued.id).status).toBe('cancelled');

    const session = valid();
    expect(session).toMatchObject({ generation: 2, status: 'active', operations: [], probes: [] });
    expect(api()).toMatchObject({ id: 'api-g2', generation: 2, observed: { state: 'stopped' } });
    const resetIndex = runtime.getEvents().findIndex((event) => event.type === 'session.reset');
    expect(runtime.getEvents().slice(resetIndex).every((event) => event.generation === 2)).toBe(true);
    expectDomainError(() => submit('container.start', { serviceId: 'api' }, { generation: 1 }), 'STALE_GENERATION', 409);
  });

  it('drops background observations scheduled by a previous generation', async () => {
    const { clock, submit, run, api } = await startRuntime();
    submit('container.start', { serviceId: 'api' });
    await clock.advance(SIMULATED_TIMINGS.startup);
    expect(api().observed.health).toBe('starting');
    await run('session.reset');
    await clock.advance(SIMULATED_TIMINGS.healthcheck * 2);
    expect(api().observed).toMatchObject({ state: 'stopped', health: 'unknown' });
  });

  it('rejects new work while a reset is in progress', async () => {
    const { clock, submit } = await startRuntime();
    submit('session.reset');
    expectDomainError(() => submit('container.start', { serviceId: 'api' }), 'SESSION_UNAVAILABLE', 409);
    await clock.runAll();
  });

  it('ends the session after cleanup and refuses further operations', async () => {
    const { run, submit, valid } = await startRuntime();
    const end = await run('session.end');
    expect(end).toMatchObject({ status: 'succeeded', result: { removed: ['api'], remaining: [] } });
    expect(valid().status).toBe('ended');
    expectDomainError(() => submit('container.start', { serviceId: 'api' }), 'SESSION_ENDED', 409);
  });

  it('marks the session degraded when fixture setup fails during reset', async () => {
    const simulator = createSimulatorExecutor();
    let failSetup = false;
    const executor = {
      ...simulator,
      setup: (input) => (failSetup ? Promise.reject(new Error('disk full')) : simulator.setup(input)),
    };
    const { run, valid, errors } = await startRuntime({ executor });
    failSetup = true;
    const reset = await run('session.reset');
    expect(reset).toMatchObject({ status: 'failed', error: { code: 'RESET_FAILED', retryable: true } });
    expect(valid().status).toBe('degraded');
    expect(errors).toHaveLength(1);
    failSetup = false;
    expect((await run('session.reset')).status).toBe('succeeded');
    expect(valid()).toMatchObject({ status: 'active', generation: 2 });
  });
});

describe('retention bounds', () => {
  it('bounds probe history, completed operations, and event history', async () => {
    const { runtime, clock, submit, valid } = await startRuntime();
    for (let index = 0; index < 270; index += 1) {
      submit('health.probe', { serviceId: 'api' });
      if (index % RUNTIME_LIMITS.activeReads === RUNTIME_LIMITS.activeReads - 1) {
        await clock.runAll();
      }
    }
    await clock.runAll();
    const session = valid();
    expect(session.probes).toHaveLength(LIMITS.probeHistory);
    expect(session.operations.length).toBeLessThanOrEqual(100);
    expect(runtime.getEvents()).toHaveLength(RUNTIME_LIMITS.events);
    expect(runtime.getEvents().at(-1).sequence).toBe(session.lastEventSequence);
  }, 20_000);

  it('evicts the oldest log entries by count and bytes and reports truncation', () => {
    const line = (message) => ({ serviceId: 'api', stream: 'stdout', level: 'info', message, at: '2026-11-04T10:00:00.000Z' });
    let buffer = emptyLogBuffer();
    buffer = appendLogEntries(buffer, Array.from({ length: 600 }, (_, index) => line(`line ${index}`)), 'simulator');
    expect(buffer.entries).toHaveLength(LIMITS.logEntries);
    expect(buffer.dropped).toBe(100);
    expect(buffer.entries[0].message).toBe('line 100');

    buffer = appendLogEntries(emptyLogBuffer(), Array.from({ length: 40 }, () => line('x'.repeat(8000))), 'simulator');
    expect(buffer.bytes).toBeLessThanOrEqual(LIMITS.logBytes);
    expect(buffer.dropped).toBe(8);
  });
});
