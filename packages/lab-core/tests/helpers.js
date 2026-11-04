import { createSession, sessionSchema } from '../src/index.js';

export const CREATED_AT = '2026-11-04T10:00:00.000Z';
export const STARTED_AT = '2026-11-04T10:00:01.000Z';
export const OBSERVED_AT = '2026-11-04T10:00:02.000Z';

export function makeManifest() {
  return {
    schemaVersion: 1,
    id: 'stopped-container',
    title: 'Restore the API',
    description: 'Inspect a stopped service and recover its HTTP health endpoint.',
    difficulty: 'beginner',
    estimatedMinutes: 5,
    supportedModes: ['demo', 'local'],
    fixtureId: 'api-stopped',
    allowedOperations: ['container.start', 'container.stop', 'container.restart',
      'container.inspect', 'container.logs', 'health.probe', 'version.probe',
      'session.reset', 'session.end'],
    objectives: [
      { id: 'inspect-evidence', label: 'Inspect the service logs', predicateId: 'evidence.logs-read', required: true },
      { id: 'recover-service', label: 'Run the API container', predicateId: 'service.running', required: true },
      { id: 'verify-health', label: 'Verify a successful health response', predicateId: 'service.health-verified', required: true },
    ],
  };
}

export function makeResource(overrides = {}) {
  return {
    id: 'resource-api',
    sessionId: 'session-001',
    generation: 1,
    serviceId: 'api',
    kind: 'container',
    desired: { image: 'api:1.0.0', appPort: 3000, expectedProbePort: 3000 },
    observed: {
      state: 'stopped',
      health: 'unknown',
      image: 'api:1.0.0',
      exitCode: 0,
      startedAt: null,
      ports: [{ containerPort: 3000, hostPort: null }],
      source: 'simulator',
      observedAt: CREATED_AT,
      unavailableReason: null,
    },
    ...overrides,
  };
}

export function makeSession(overrides = {}) {
  const ids = ['session-001', 'epoch-001'];
  const state = createSession({
    manifest: makeManifest(),
    resources: [makeResource()],
    now: () => CREATED_AT,
    nextId: () => ids.shift(),
  });
  return sessionSchema.parse({ ...state, status: 'active', ...overrides });
}

export function makeOperation(status = 'queued', overrides = {}) {
  return {
    id: 'operation-001',
    sessionId: 'session-001',
    generation: 1,
    idempotencyKey: 'request-001',
    type: 'container.start',
    parameters: { serviceId: 'api' },
    status,
    startedAt: status === 'queued' ? null : STARTED_AT,
    finishedAt: ['succeeded', 'failed', 'cancelled'].includes(status) ? OBSERVED_AT : null,
    result: status === 'succeeded' ? { state: 'running' } : null,
    error: status === 'failed' ? { code: 'DOCKER_UNAVAILABLE', message: 'Docker is unavailable.', retryable: true } : null,
    ...overrides,
  };
}

export function makeEvent(state, overrides = {}) {
  const event = {
    schemaVersion: 1,
    sessionId: state.id,
    generation: state.generation,
    eventEpoch: state.eventEpoch,
    sequence: state.lastEventSequence + 1,
    revision: state.revision + 1,
    type: 'resource.observed',
    occurredAt: OBSERVED_AT,
    operationId: null,
    source: state.mode === 'demo' ? 'simulator' : 'docker',
    payload: { resourceId: 'resource-api', state: 'running' },
    ...overrides,
  };
  return { ...event, id: `${event.sessionId}:${event.eventEpoch}:${event.sequence}` };
}

export function operationEvent(state, status, overrides = {}) {
  const type = status === 'running' ? 'operation.started' : `operation.${status}`;
  const operation = makeOperation(status, { generation: state.generation, ...overrides });
  return makeEvent(state, { type, operationId: operation.id, payload: { operation } });
}
