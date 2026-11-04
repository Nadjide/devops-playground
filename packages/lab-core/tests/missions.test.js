import { describe, expect, it } from 'vitest';
import {
  availableLabs, createLabRuntime, createSimulatorExecutor, DomainError, FRESHNESS_MS, getFixture,
  labCatalog, PREDICATES, reduceSession, SessionStateError, SIMULATED_OPERATIONS, SIMULATED_TIMINGS,
} from '../src/index.js';
import { startRuntime } from './runtime-helpers.js';

const objective = (session, id) => session.mission.objectives.find((item) => item.id === id);

describe('M01 restore a stopped API', () => {
  it('completes only after evidence, a running container, and a fresh health response', async () => {
    const { run, valid } = await startRuntime();
    expect(valid().mission.status).toBe('not-started');

    await run('container.logs', { serviceId: 'api', tail: 50 });
    expect(objective(valid(), 'inspect-evidence')).toMatchObject({ status: 'satisfied', evidence: { source: 'simulator', generation: 1 } });
    expect(objective(valid(), 'inspect-evidence').evidence.explanation).toMatch(/Read \d+ log line\(s\) from api/);
    expect(valid().mission.status).toBe('in-progress');

    await run('container.start', { serviceId: 'api' });
    expect(objective(valid(), 'recover-service').status).toBe('satisfied');
    // Starting a container without a health probe leaves verification pending.
    expect(objective(valid(), 'verify-health').status).toBe('pending');
    expect(valid().mission.status).toBe('in-progress');

    await run('health.probe', { serviceId: 'api' });
    const session = valid();
    expect(objective(session, 'verify-health').status).toBe('satisfied');
    expect(objective(session, 'verify-health').evidence.explanation).toMatch(/returned 200 with status ok/);
    expect(session.mission).toMatchObject({ status: 'completed', completion: { generation: 1 } });
    expect(session.mission.completion.revision).toBeLessThanOrEqual(session.revision);
  });

  it('counts an inspect result as diagnostic evidence', async () => {
    const { run, valid } = await startRuntime();
    await run('container.inspect', { serviceId: 'api' });
    expect(objective(valid(), 'inspect-evidence').evidence.explanation).toMatch(/Inspected api/);
  });

  it('keeps the historical completion when the service later stops', async () => {
    const { run, valid } = await startRuntime();
    await run('container.logs', { serviceId: 'api', tail: 50 });
    await run('container.start', { serviceId: 'api' });
    await run('health.probe', { serviceId: 'api' });
    const completion = valid().mission.completion;

    await run('container.stop', { serviceId: 'api' });
    const session = valid();
    expect(objective(session, 'recover-service').status).toBe('invalidated');
    expect(objective(session, 'verify-health').status).toBe('invalidated');
    expect(objective(session, 'inspect-evidence').status).toBe('satisfied');
    expect(session.mission).toMatchObject({ status: 'completed', completion });

    await run('container.start', { serviceId: 'api' });
    // The previous probe predates the new process, so health needs fresh evidence.
    expect(objective(valid(), 'verify-health').status).toBe('invalidated');
    await run('health.probe', { serviceId: 'api' });
    expect(objective(valid(), 'verify-health').status).toBe('satisfied');
  });

  it('does not accept failed probes or repeated clicks as verification', async () => {
    const { run, valid } = await startRuntime();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await run('health.probe', { serviceId: 'api' });
    }
    expect(objective(valid(), 'verify-health').status).toBe('pending');
    expect(valid().mission.completion).toBeNull();
  });

  it('clears objectives and completion on reset', async () => {
    const { run, valid } = await startRuntime();
    await run('container.logs', { serviceId: 'api', tail: 50 });
    await run('container.start', { serviceId: 'api' });
    await run('health.probe', { serviceId: 'api' });
    await run('session.reset');
    expect(valid().mission).toEqual({
      id: 'stopped-container',
      status: 'not-started',
      completion: null,
      objectives: valid().mission.objectives.map(({ id }) => ({ id, status: 'pending', evidence: null })),
    });
  });
});

describe('M02 fix a port configuration', () => {
  it('starts with a running but unreachable API and a visible mismatch', async () => {
    const { run, api, valid } = await startRuntime({ labId: 'wrong-port' });
    expect(api()).toMatchObject({ desired: { appPort: 3001, expectedProbePort: 3000 }, observed: { state: 'running', health: 'unhealthy' } });
    expect(valid().logs.entries.map((entry) => entry.message)).toContain('Configuration loaded: APP_PORT=3001');
    const probe = await run('health.probe', { serviceId: 'api' });
    expect(probe.error.message).toMatch(/ECONNREFUSED api:3000/);
    expect(objective(valid(), 'apply-port').status).toBe('pending');
  });

  it('completes after the approved appPort replaces the workload and health is verified', async () => {
    const { run, api, valid, clock } = await startRuntime({ labId: 'wrong-port' });
    await run('container.inspect', { serviceId: 'api' });
    const configure = await run('service.configure', { serviceId: 'api', appPort: 3000 });
    expect(configure.result).toMatchObject({ appPort: 3000, replaced: true, state: 'running' });
    expect(api()).toMatchObject({ desired: { appPort: 3000 }, observed: { state: 'running', ports: [{ containerPort: 3000, hostPort: null }] } });
    expect(valid().logs.entries.map((entry) => entry.message)).toEqual(expect.arrayContaining([
      'Container api recreated from devops-playground-lab/api:1.0.0 with APP_PORT=3000',
      'DevOps Playground API 1.0.0 listening on port 3000',
    ]));
    expect(objective(valid(), 'apply-port').status).toBe('satisfied');
    expect(objective(valid(), 'verify-health').status).toBe('pending');

    await clock.advance(SIMULATED_TIMINGS.healthcheck);
    expect(api().observed.health).toBe('healthy');
    await run('health.probe', { serviceId: 'api' });
    expect(valid().mission.status).toBe('completed');
  });

  it('keeps the expected port authoritative', async () => {
    const { run, runtime, valid } = await startRuntime({ labId: 'wrong-port' });
    await run('service.configure', { serviceId: 'api', appPort: 3002 });
    await run('health.probe', { serviceId: 'api' });
    expect(objective(valid(), 'apply-port').status).toBe('pending');
    expect(objective(valid(), 'verify-health').status).toBe('pending');
    // The probe target is not a request parameter, so it cannot be redirected.
    expect(() => runtime.submit({ type: 'health.probe', generation: 1, parameters: { serviceId: 'api', port: 3002 } },
      { idempotencyKey: 'probe-port' })).toThrow(DomainError);
  });

  it.each([
    [{ serviceId: 'api', appPort: 80 }, 'INVALID_OPERATION'],
    [{ serviceId: 'api', appPort: '3000' }, 'INVALID_OPERATION'],
    [{ serviceId: 'api', appPort: 3000, expectedProbePort: 3001 }, 'INVALID_OPERATION'],
    [{ serviceId: 'api', appPort: 3000, env: { NODE_OPTIONS: '--inspect' } }, 'INVALID_OPERATION'],
    [{ serviceId: 'db', appPort: 3000 }, 'UNKNOWN_SERVICE'],
  ])('rejects configuration %j', async (parameters, code) => {
    const { runtime } = await startRuntime({ labId: 'wrong-port' });
    expect(() => runtime.submit({ type: 'service.configure', generation: 1, parameters }, { idempotencyKey: 'cfg' }))
      .toThrow(expect.objectContaining({ code }));
  });

  it('does not allow configuration in the stopped-container mission', async () => {
    const { runtime } = await startRuntime();
    expect(() => runtime.submit({ type: 'service.configure', generation: 1, parameters: { serviceId: 'api', appPort: 3000 } },
      { idempotencyKey: 'cfg' })).toThrow(expect.objectContaining({ code: 'OPERATION_NOT_ALLOWED' }));
  });
});

describe('predicate freshness and registry', () => {
  it('requires health evidence to be fresh when it first satisfies an objective', () => {
    const startedAt = '2026-11-04T10:00:00.000Z';
    const probeAt = '2026-11-04T10:00:05.000Z';
    const session = {
      resources: [{ serviceId: 'api', desired: { appPort: 3000, expectedProbePort: 3000 }, observed: { state: 'running', startedAt, ports: [] } }],
      probes: [{ kind: 'health', serviceId: 'api', ok: true, statusCode: 200, port: 3000, observedAt: probeAt, source: 'simulator', body: { status: 'ok', service: 'devops-playground' } }],
      operations: [],
    };
    const evaluate = (nowOffset, status) => PREDICATES['service.health-verified'].evaluate({
      session, fixture: getFixture('api-stopped'), nowMs: Date.parse(probeAt) + nowOffset, previous: { status },
    }).holds;
    expect(evaluate(FRESHNESS_MS, 'pending')).toBe(true);
    expect(evaluate(FRESHNESS_MS + 1, 'pending')).toBe(false);
    expect(evaluate(FRESHNESS_MS + 1, 'satisfied')).toBe(true);
  });

  it('lists only labs the backend can run completely', () => {
    expect(availableLabs({ mode: 'demo', operations: SIMULATED_OPERATIONS }).map((lab) => lab.id))
      .toEqual(['stopped-container', 'wrong-port', 'broken-release', 'storage-provision', 'blob-provision', 'storage-config', 'blob-config', 'free-exploration']);
    const limited = SIMULATED_OPERATIONS.filter((type) => type !== 'service.configure');
    expect(availableLabs({ mode: 'demo', operations: limited }).map((lab) => lab.id))
      .toEqual(['stopped-container', 'broken-release', 'storage-provision', 'blob-provision', 'storage-config', 'blob-config']);
    const local = availableLabs({ mode: 'local', operations: SIMULATED_OPERATIONS }).map((lab) => lab.id);
    expect(local).toContain('storage-provision');
    expect(local).not.toContain('blob-provision');
    expect(labCatalog.every((lab) => lab.objectives.every((item) => item.predicateId in PREDICATES))).toBe(true);
  });

  it('rejects mission updates that rewrite a completion record', async () => {
    const { run, valid } = await startRuntime();
    await run('container.logs', { serviceId: 'api', tail: 50 });
    await run('container.start', { serviceId: 'api' });
    await run('health.probe', { serviceId: 'api' });
    const session = valid();
    const forged = { ...session.mission, completion: { ...session.mission.completion, revision: 1 } };
    const event = {
      schemaVersion: 1, id: `${session.id}:${session.eventEpoch}:${session.lastEventSequence + 1}`, sessionId: session.id,
      generation: 1, eventEpoch: session.eventEpoch, sequence: session.lastEventSequence + 1, revision: session.revision + 1,
      type: 'mission.updated', occurredAt: session.updatedAt, operationId: null, source: 'simulator', payload: forged,
    };
    expect(() => reduceSession(session, event)).toThrow(SessionStateError);
  });
});

describe('free exploration', () => {
  it('starts any approved fixture and never completes', async () => {
    const { run, api, valid } = await startRuntime({ labId: 'free-exploration', fixtureId: 'api-wrong-port' });
    expect(valid()).toMatchObject({ labId: 'free-exploration', fixtureId: 'api-wrong-port', mission: { objectives: [] } });
    expect(api().desired.appPort).toBe(3001);
    await run('service.configure', { serviceId: 'api', appPort: 3000 });
    await run('health.probe', { serviceId: 'api' });
    expect(valid().mission).toMatchObject({ status: 'in-progress', completion: null });
    await run('session.reset');
    expect(api().desired.appPort).toBe(3001);
  });

  it('rejects fixtures outside the lab options', () => {
    expect(() => createLabRuntime({ labId: 'stopped-container', fixtureId: 'api-wrong-port', executor: createSimulatorExecutor() }))
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_FIXTURE' }));
  });
});
