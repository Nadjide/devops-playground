import { describe, expect, it, vi } from 'vitest';
import { createSession, reduceSession, replaceSessionSnapshot, SessionStateError } from '@devops-playground/lab-core';
import {
  CREATED_AT, OBSERVED_AT, makeEvent, makeManifest, makeOperation, makeResource,
  makeSession, operationEvent,
} from './helpers.js';

function expectStateError(callback, code) {
  expect(callback).toThrow(SessionStateError);
  expect(callback).toThrow(expect.objectContaining({ code }));
}

describe('session creation', () => {
  it('uses the injected clock and ID source deterministically', () => {
    const ids = ['session-001', 'epoch-001'];
    const now = vi.fn(() => CREATED_AT);
    const nextId = vi.fn(() => ids.shift());
    const state = createSession({ manifest: makeManifest(), now, nextId });

    expect(state).toMatchObject({ id: 'session-001', eventEpoch: 'epoch-001', status: 'initializing', revision: 0 });
    expect(state.createdAt).toBe(CREATED_AT);
    expect(now).toHaveBeenCalledTimes(1);
    expect(nextId).toHaveBeenCalledTimes(2);
    expect(state.mission.objectives).toHaveLength(3);
    expect(state.mission.objectives.every((objective) => objective.status === 'pending')).toBe(true);
  });

  it('has usable browser-compatible default clock and ID implementations', () => {
    const state = createSession({ manifest: makeManifest() });
    expect(state.id).not.toBe(state.eventEpoch);
    expect(Number.isNaN(Date.parse(state.createdAt))).toBe(false);
  });

  it('rejects a mode outside the manifest capability', () => {
    const manifest = { ...makeManifest(), supportedModes: ['demo'] };
    expectStateError(() => createSession({ manifest, mode: 'local' }), 'UNSUPPORTED_MODE');
  });
});

describe('pure event reduction', () => {
  it('updates observation, provenance, cursor, revision, and time without mutating inputs', () => {
    const state = makeSession();
    const event = makeEvent(state, { payload: { resourceId: 'resource-api', state: 'running', health: 'healthy' } });
    const originalState = globalThis.structuredClone(state);
    const originalEvent = globalThis.structuredClone(event);
    const next = reduceSession(state, event);

    expect(next.resources[0].observed).toMatchObject({ state: 'running', health: 'healthy', source: 'simulator', observedAt: OBSERVED_AT });
    expect(next.revision).toBe(1);
    expect(next.lastEventSequence).toBe(1);
    expect(next.updatedAt).toBe(OBSERVED_AT);
    expect(state).toEqual(originalState);
    expect(event).toEqual(originalEvent);
  });

  it('returns the original snapshot for a duplicate event', () => {
    const state = makeSession();
    const event = makeEvent(state);
    const next = reduceSession(state, event);
    expect(reduceSession(next, event)).toBe(next);
  });

  it('ignores an event from a replaced epoch', () => {
    const state = makeSession({ eventEpoch: 'epoch-new' });
    expect(reduceSession(state, makeEvent(state, { eventEpoch: 'epoch-old' }))).toBe(state);
  });

  it('ignores late work from a previous reset generation', () => {
    const state = makeSession({ generation: 2, resources: [makeResource({ generation: 2 })] });
    expect(reduceSession(state, makeEvent(state, { generation: 1 }))).toBe(state);
  });

  it.each([
    [{ sessionId: 'foreign' }, 'FOREIGN_SESSION'],
    [{ generation: 2 }, 'GENERATION_CONFLICT'],
    [{ sequence: 2 }, 'EVENT_GAP'],
    [{ revision: 2 }, 'REVISION_CONFLICT'],
    [{ occurredAt: '2025-01-01T00:00:00.000Z' }, 'EVENT_TIME_CONFLICT'],
    [{ source: 'docker' }, 'SOURCE_CONFLICT'],
    [{ payload: { resourceId: 'foreign', state: 'running' } }, 'UNKNOWN_RESOURCE'],
  ])('rejects conflicting event input %#', (overrides, code) => {
    const state = makeSession();
    expectStateError(() => reduceSession(state, makeEvent(state, overrides)), code);
    expect(state.revision).toBe(0);
  });

  it('keeps actual local provenance when reducing a Docker observation', () => {
    const resource = makeResource();
    resource.observed.source = 'docker';
    const state = makeSession({ mode: 'local', resources: [resource] });
    const next = reduceSession(state, makeEvent(state));
    expect(next.resources[0].observed.source).toBe('docker');
  });

  it('rejects invalid session lifecycle transitions', () => {
    const state = makeSession();
    expectStateError(() => reduceSession(state, makeEvent(state, {
      type: 'session.status-changed', payload: { status: 'initializing' },
    })), 'INVALID_SESSION_TRANSITION');
  });

  it('requires explicit reset preparation and clears previous generation data', () => {
    const state = makeSession();
    const resetPayload = { resources: [makeResource({ generation: 2 })], mission: state.mission, pipeline: state.pipeline, storage: null };
    expectStateError(() => reduceSession(state, makeEvent(state, {
      type: 'session.reset', generation: 2, payload: resetPayload,
    })), 'RESET_NOT_STARTED');

    const resetting = reduceSession(state, makeEvent(state, {
      type: 'session.status-changed', payload: { status: 'resetting' },
    }));
    const reset = reduceSession(resetting, makeEvent(resetting, {
      type: 'session.reset', generation: 2, payload: resetPayload,
    }));
    expect(reset).toMatchObject({ generation: 2, status: 'active', revision: 2, lastEventSequence: 2, operations: [] });
    expect(reset.resources[0].generation).toBe(2);
    expect(reset.eventEpoch).toBe(state.eventEpoch);
  });

  it('rejects reset with active operations or fabricated mission objectives', () => {
    const state = makeSession({ status: 'resetting', operations: [makeOperation()] });
    const payload = { resources: [], mission: state.mission, pipeline: state.pipeline, storage: null };
    expectStateError(() => reduceSession(state, makeEvent(state, {
      type: 'session.reset', generation: 2, payload,
    })), 'OPERATIONS_ACTIVE');

    const clean = makeSession({ status: 'resetting' });
    expectStateError(() => reduceSession(clean, makeEvent(clean, {
      type: 'session.reset', generation: 2,
      payload: { resources: [], mission: { ...clean.mission, objectives: [] }, pipeline: clean.pipeline, storage: null },
    })), 'INVALID_RESET_MISSION');
  });
});

describe('operation lifecycle reduction', () => {
  it('reduces a queued, running, successful operation', () => {
    let state = makeSession();
    for (const status of ['queued', 'running', 'succeeded']) {
      state = reduceSession(state, operationEvent(state, status));
    }
    expect(state.operations).toHaveLength(1);
    expect(state.operations[0].status).toBe('succeeded');
    expect(state.revision).toBe(3);
  });

  it.each(['failed', 'cancelled'])('supports %s after queuing', (status) => {
    let state = makeSession();
    state = reduceSession(state, operationEvent(state, 'queued'));
    state = reduceSession(state, operationEvent(state, status, { startedAt: null }));
    expect(state.operations[0].status).toBe(status);
  });

  it('rejects operation progress before queue registration', () => {
    const state = makeSession();
    expectStateError(() => reduceSession(state, operationEvent(state, 'running')), 'UNKNOWN_OPERATION');
  });

  it('rejects changed identities, changed parameters, and terminal-state rewrites', () => {
    const queued = reduceSession(makeSession(), operationEvent(makeSession(), 'queued'));
    expectStateError(() => reduceSession(queued, operationEvent(queued, 'running', { parameters: { serviceId: 'other' } })),
      'OPERATION_IDENTITY_CHANGED');
    const running = reduceSession(queued, operationEvent(queued, 'running'));
    const done = reduceSession(running, operationEvent(running, 'succeeded'));
    expectStateError(() => reduceSession(done, operationEvent(done, 'running')), 'INVALID_OPERATION_TRANSITION');
  });

  it('rejects duplicate operation IDs and idempotency keys', () => {
    const initial = makeSession();
    const state = reduceSession(initial, operationEvent(initial, 'queued'));
    expectStateError(() => reduceSession(state, operationEvent(state, 'queued')), 'DUPLICATE_OPERATION');
    expectStateError(() => reduceSession(state, operationEvent(state, 'queued', { id: 'operation-002' })), 'DUPLICATE_IDEMPOTENCY_KEY');
  });

  it('rejects operations referring to a missing service', () => {
    const state = makeSession();
    expect(() => reduceSession(state, operationEvent(state, 'queued', {
      parameters: { serviceId: 'foreign-service' },
    }))).toThrow(/unknown service/);
  });

  it('requires operation reconciliation before ending a session', () => {
    let state = makeSession({ status: 'ending', operations: [makeOperation()] });
    expectStateError(() => reduceSession(state, makeEvent(state, {
      type: 'session.status-changed', payload: { status: 'ended' },
    })), 'OPERATIONS_ACTIVE');
    state = reduceSession(state, operationEvent(state, 'cancelled', { startedAt: null }));
    state = reduceSession(state, makeEvent(state, {
      type: 'session.status-changed', payload: { status: 'ended' },
    }));
    expect(state.status).toBe('ended');
  });

  it('rejects operation progress delivered after a session ended', () => {
    const state = makeSession({ status: 'ended', operations: [makeOperation()] });
    expectStateError(() => reduceSession(state, operationEvent(state, 'running')), 'SESSION_ENDED');
  });
});

describe('snapshot replacement', () => {
  it('accepts a new epoch and safely ignores old-epoch events afterwards', () => {
    const original = makeSession();
    const current = reduceSession(original, makeEvent(original));
    const fresh = { ...current, eventEpoch: 'epoch-002', lastEventSequence: 0, revision: 0 };
    const recovered = replaceSessionSnapshot(current, fresh);
    expect(recovered.eventEpoch).toBe('epoch-002');
    expect(reduceSession(recovered, makeEvent(current))).toBe(recovered);
  });

  it('rejects an older snapshot in the current epoch', () => {
    const original = makeSession();
    const next = reduceSession(original, makeEvent(original));
    expectStateError(() => replaceSessionSnapshot(next, original), 'STALE_SNAPSHOT');
  });

  it.each([
    { id: 'foreign' },
    { labId: 'other-lab', mission: { id: 'other-lab', status: 'not-started', objectives: [], completion: null } },
  ])('rejects replacement of session identity %#', (overrides) => {
    const current = makeSession({ resources: [] });
    expectStateError(() => replaceSessionSnapshot(current, { ...current, ...overrides }), 'SNAPSHOT_IDENTITY_CHANGED');
  });
});
