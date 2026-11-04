import { operationRequestSchema } from '../schemas/operations.js';
import { identifierSchema } from '../schemas/shared.js';
import { LIMITS } from '../schemas/observations.js';
import { getLabManifest } from '../missions/catalog.js';
import { evaluateMission } from '../missions/evaluate.js';
import { getFixture } from '../fixtures/catalog.js';
import { createSession, emptyPipeline, freshMission, reduceSession, SessionStateError } from './session.js';
import { isCancellable } from '../pipeline/recorder.js';
import { hydrateSession } from '../checkpoint/checkpoint.js';
import { createSystemClock, delay } from './clock.js';
import { sanitizeLogMessage } from '../commands/sanitize.js';
import { AbortedError, DomainError, OperationFailure } from './errors.js';

export const RUNTIME_LIMITS = Object.freeze({
  events: 1000,
  idempotencyKeys: 256,
  pendingMutations: 10,
  activeReads: 10,
  retainedOperations: 100,
});

export const READ_ONLY_OPERATIONS = Object.freeze([
  'container.inspect', 'container.logs', 'health.probe', 'version.probe',
]);
const LIFECYCLE_OPERATIONS = ['session.reset', 'session.end'];
const PIPELINE_OPERATIONS = ['pipeline.run', 'pipeline.rollback'];
const ACTIVE = ['queued', 'running'];
const TERMINAL = ['succeeded', 'failed', 'cancelled'];

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const clone = (value) => (value === undefined ? value : structuredClone(value));

/**
 * Owns one lab session: validates requests, serializes mutations, applies
 * every observation through the pure reducer, and keeps bounded history.
 * The executor decides how operations happen (simulator or real runner).
 */
export function createLabRuntime({
  labId,
  fixtureId: requestedFixture,
  mode = 'demo',
  executor,
  clock = createSystemClock(),
  nextId = () => globalThis.crypto.randomUUID(),
  source = mode === 'demo' ? 'simulator' : 'docker',
  onError = () => {},
}) {
  const lab = getLabManifest(labId);
  const fixtureId = requestedFixture ?? lab.fixtureId;
  if (fixtureId !== lab.fixtureId && !lab.fixtureOptions?.includes(fixtureId)) {
    throw new DomainError('UNSUPPORTED_FIXTURE', 'The lab does not offer this fixture.', { status: 422 });
  }
  const fixture = getFixture(fixtureId);
  const supported = new Set(lab.allowedOperations.filter((type) => executor.supportedOperations.includes(type)));
  const listeners = new Set();
  const registry = new Map();
  const idempotency = new Map();
  const waiters = new Map();
  const active = new Map();
  const timers = new Set();
  let session = null;
  let events = [];
  let mutationChain = Promise.resolve();
  let lifecycle = null;

  function timestamp() {
    const floor = session ? Date.parse(session.updatedAt) : 0;
    return new Date(Math.max(clock.now(), floor)).toISOString();
  }

  function notify(event) {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        onError(error);
      }
    }
  }

  function emit(type, payload, { operationId = null, generation = session.generation, eventSource = source } = {}) {
    const sequence = session.lastEventSequence + 1;
    const event = {
      schemaVersion: 1,
      id: `${session.id}:${session.eventEpoch}:${sequence}`,
      sessionId: session.id,
      generation,
      eventEpoch: session.eventEpoch,
      sequence,
      revision: session.revision + 1,
      type,
      occurredAt: timestamp(),
      operationId,
      source: eventSource,
      payload,
    };
    const next = reduceSession(session, event);
    if (next === session) {
      return null;
    }
    session = next;
    events = events.length >= RUNTIME_LIMITS.events
      ? [...events.slice(events.length - RUNTIME_LIMITS.events + 1), event]
      : [...events, event];
    notify(event);
    if (type !== 'mission.updated' && ['active', 'degraded'].includes(session.status)) {
      const progress = evaluateMission(session, lab, { event, nowMs: clock.now(), fixture });
      if (progress) {
        emit('mission.updated', progress);
      }
    }
    return event;
  }

  function emitLogs(input, options) {
    // Every driver's log text crosses this boundary, so sanitize it once here.
    const lines = input.map((line) => ({ ...line, message: sanitizeLogMessage(line.message) }));
    for (let index = 0; index < lines.length; index += LIMITS.logBatch) {
      emit('log.appended', { entries: lines.slice(index, index + LIMITS.logBatch) }, options);
    }
  }

  function record(operation) {
    registry.set(operation.id, operation);
    if (TERMINAL.includes(operation.status)) {
      for (const resolve of waiters.get(operation.id) ?? []) {
        resolve(clone(operation));
      }
      waiters.delete(operation.id);
      const completed = [...registry.values()].filter((item) => TERMINAL.includes(item.status));
      for (const old of completed.slice(0, Math.max(0, completed.length - RUNTIME_LIMITS.retainedOperations))) {
        registry.delete(old.id);
      }
    }
    return operation;
  }

  function transition(operation, status, fields = {}) {
    const next = record({ ...operation, status, ...fields });
    const tracked = !LIFECYCLE_OPERATIONS.includes(next.type);
    if (tracked && session.generation === next.generation &&
        session.operations.some((item) => item.id === next.id)) {
      try {
        emit(status === 'running' ? 'operation.started' : `operation.${status}`, { operation: next },
          { operationId: next.id });
      } catch (error) {
        if (!(error instanceof SessionStateError)) {
          throw error;
        }
        onError(error);
      }
    }
    return next;
  }

  function finish(operation, outcome) {
    const finishedAt = timestamp();
    if (outcome.status === 'succeeded') {
      return transition(operation, 'succeeded', { finishedAt, result: outcome.result ?? null, error: null });
    }
    return transition(operation, outcome.status, { finishedAt, result: null, error: outcome.error ?? null });
  }

  function schedule(ms, callback, generation) {
    const handle = clock.setTimeout(() => {
      timers.delete(handle);
      if (!session || session.generation !== generation || !['active', 'degraded'].includes(session.status)) {
        return;
      }
      try {
        callback({ session: () => session, emit: (type, payload) => emit(type, payload), emitLogs });
      } catch (error) {
        onError(error);
      }
    }, ms);
    timers.add(handle);
  }

  function clearTimers() {
    for (const handle of timers) {
      clock.clearTimeout(handle);
    }
    timers.clear();
  }

  function context(operation, signal) {
    const { generation } = operation;
    const guard = () => {
      if (signal.aborted) {
        throw new AbortedError();
      }
      if (session.generation !== generation) {
        throw new OperationFailure('STALE_GENERATION', 'The session was reset while the operation ran.');
      }
    };
    return {
      operation,
      signal,
      session: () => session,
      now: timestamp,
      emit(type, payload) {
        guard();
        return emit(type, payload, { operationId: operation.id });
      },
      emitLogs(lines) {
        guard();
        emitLogs(lines, { operationId: operation.id });
      },
      /** Record final state after cancellation; still refuses a replaced generation. */
      reconcile(type, payload) {
        if (session.generation !== generation) {
          return null;
        }
        return emit(type, payload, { operationId: operation.id });
      },
      delay: (ms) => delay(clock, ms, signal),
      later: (ms, callback) => schedule(ms, callback, generation),
    };
  }

  async function execute(queued) {
    const latest = registry.get(queued.id);
    if (!latest || latest.status !== 'queued' || session.generation !== queued.generation) {
      return;
    }
    const controller = new AbortController();
    const running = transition(latest, 'running', { startedAt: timestamp() });
    let settle;
    active.set(running.id, { controller, done: new Promise((resolve) => { settle = resolve; }) });
    try {
      const result = await executor.execute(clone(running), context(running, controller.signal));
      finish(running, { status: 'succeeded', result });
    } catch (error) {
      if (controller.signal.aborted || error instanceof AbortedError) {
        finish(running, { status: 'cancelled' });
      } else if (error instanceof OperationFailure) {
        finish(running, { status: 'failed', error: { code: error.code, message: error.message, retryable: error.retryable } });
      } else {
        onError(error);
        finish(running, {
          status: 'failed',
          error: { code: 'EXECUTION_FAILED', message: 'The operation failed unexpectedly.', retryable: true },
        });
      }
    } finally {
      active.delete(running.id);
      settle();
    }
  }

  /** Cancel runs immediately rather than queueing behind the run it targets. */
  async function cancelPipeline(operation, targetId) {
    const running = transition(operation, 'running', { startedAt: timestamp() });
    const target = registry.get(targetId);
    if (target?.status === 'queued') {
      transition(target, 'cancelled', { finishedAt: timestamp() });
    } else {
      const handle = active.get(targetId);
      handle?.controller.abort();
      await handle?.done;
    }
    finish(running, { status: 'succeeded', result: { cancelled: targetId } });
  }

  async function drain() {
    for (const operation of session.operations) {
      if (operation.status === 'queued') {
        transition(registry.get(operation.id) ?? operation, 'cancelled', { finishedAt: timestamp() });
      }
    }
    for (const { controller } of active.values()) {
      controller.abort();
    }
    await Promise.all([...active.values()].map(({ done }) => done));
  }

  async function prepareFixture(generation) {
    const setup = await executor.setup({
      labId: lab.id,
      fixtureId,
      sessionId: session?.id ?? null,
      generation,
      now: timestamp(),
    });
    return setup;
  }

  async function runReset(operation) {
    let current = record({ ...operation, status: 'running', startedAt: timestamp() });
    try {
      await drain();
      if (session.status !== 'resetting') {
        emit('session.status-changed', { status: 'resetting' });
      }
      clearTimers();
      await executor.teardown?.({ session: clone(session), reason: 'reset' });
      const generation = session.generation + 1;
      const setup = await prepareFixture(generation);
      emit('session.reset', {
        resources: setup.resources,
        mission: freshMission(lab),
        pipeline: setup.pipeline ?? emptyPipeline(),
      }, { generation });
      if (setup.logs?.length) {
        emitLogs(setup.logs);
      }
      current = finish(current, { status: 'succeeded', result: { generation } });
    } catch (error) {
      onError(error);
      if (session.status === 'resetting') {
        emit('session.status-changed', { status: 'degraded' });
      }
      current = finish(current, {
        status: 'failed',
        error: { code: 'RESET_FAILED', message: 'The session could not be reset. Retry the reset.', retryable: true },
      });
    }
    return current;
  }

  async function runEnd(operation) {
    let current = record({ ...operation, status: 'running', startedAt: timestamp() });
    try {
      await drain();
      emit('session.status-changed', { status: 'ending' });
      clearTimers();
      const cleanup = await executor.teardown?.({ session: clone(session), reason: 'end' }) ?? { removed: [], remaining: [] };
      if (cleanup.remaining?.length) {
        emit('session.status-changed', { status: 'degraded' });
        return finish(current, {
          status: 'failed',
          error: { code: 'CLEANUP_INCOMPLETE', message: 'Some session resources could not be removed.', retryable: true },
        });
      }
      emit('session.status-changed', { status: 'ended' });
      current = finish(current, { status: 'succeeded', result: cleanup });
    } catch (error) {
      onError(error);
      if (session.status === 'ending') {
        emit('session.status-changed', { status: 'degraded' });
      }
      current = finish(current, {
        status: 'failed',
        error: { code: 'CLEANUP_FAILED', message: 'Session cleanup failed. Retry ending the session.', retryable: true },
      });
    }
    return current;
  }

  function runLifecycle(operation) {
    lifecycle = operation.type;
    const task = operation.type === 'session.reset' ? runReset(operation) : runEnd(operation);
    task.finally(() => {
      lifecycle = null;
    });
  }

  function requireAccepting(type) {
    if (!session) {
      throw new DomainError('SESSION_UNAVAILABLE', 'The session is still starting.', { status: 409, retryable: true });
    }
    if (session.status === 'ended') {
      throw new DomainError('SESSION_ENDED', 'This session has ended. Start a new session.', { status: 409 });
    }
    const degradedLifecycle = session.status === 'degraded' && LIFECYCLE_OPERATIONS.includes(type);
    if (lifecycle || (session.status !== 'active' && !degradedLifecycle)) {
      throw new DomainError('SESSION_UNAVAILABLE',
        'The session cannot accept this operation in its current state.', { status: 409, retryable: true });
    }
  }

  function submit(input, { idempotencyKey } = {}) {
    const parsed = operationRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new DomainError('INVALID_OPERATION', 'The operation request is malformed or unsupported.', {
        status: 400,
        details: { issues: parsed.error.issues.slice(0, 5).map((issue) => issue.message) },
      });
    }
    if (!identifierSchema.safeParse(idempotencyKey).success) {
      throw new DomainError('INVALID_IDEMPOTENCY_KEY', 'A valid idempotency key is required.', { status: 400 });
    }
    const request = parsed.data;
    const fingerprint = stableStringify(request);
    const previous = idempotency.get(idempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', 'The idempotency key was already used for another request.', {
          status: 409, operationId: previous.operationId,
        });
      }
      const original = registry.get(previous.operationId) ??
        session?.operations.find((operation) => operation.id === previous.operationId);
      if (original) {
        return clone(original);
      }
      idempotency.delete(idempotencyKey);
    }
    if (!lab.allowedOperations.includes(request.type)) {
      throw new DomainError('OPERATION_NOT_ALLOWED', 'The active lab does not allow this operation.', { status: 422 });
    }
    if (!supported.has(request.type)) {
      throw new DomainError('CAPABILITY_UNAVAILABLE', 'The execution backend does not support this operation.', { status: 422 });
    }
    requireAccepting(request.type);
    if (request.generation !== session.generation) {
      throw new DomainError('STALE_GENERATION', 'The request targets a previous session generation.', {
        status: 409, details: { generation: session.generation },
      });
    }
    const { serviceId } = request.parameters;
    if (serviceId !== undefined && !session.resources.some((resource) => resource.serviceId === serviceId)) {
      throw new DomainError('UNKNOWN_SERVICE', 'The service does not belong to this session.', { status: 404 });
    }
    const activePipeline = session.operations.find((operation) => ACTIVE.includes(operation.status) &&
      PIPELINE_OPERATIONS.includes(operation.type));
    if (PIPELINE_OPERATIONS.includes(request.type) && activePipeline) {
      throw new DomainError('PIPELINE_BUSY', 'A pipeline run is already in progress.', {
        status: 409, retryable: true, operationId: activePipeline.id,
      });
    }
    if (request.type === 'pipeline.cancel') {
      const run = session.pipeline.runs.find((item) => item.id === activePipeline?.id);
      if (!activePipeline) {
        throw new DomainError('NOTHING_TO_CANCEL', 'No pipeline run is in progress.', { status: 409 });
      }
      if (activePipeline.status === 'running' && !isCancellable(run)) {
        throw new DomainError('CANCEL_UNSAFE',
          'Cancellation is only safe before the deploy stage changes the service.', { status: 409, operationId: activePipeline.id });
      }
    }
    const readOnly = READ_ONLY_OPERATIONS.includes(request.type);
    const pending = session.operations.filter((operation) => ACTIVE.includes(operation.status) &&
      READ_ONLY_OPERATIONS.includes(operation.type) === readOnly).length;
    if (pending >= (readOnly ? RUNTIME_LIMITS.activeReads : RUNTIME_LIMITS.pendingMutations)) {
      throw new DomainError('CAPACITY_EXCEEDED', 'Too many operations are pending. Wait for them to finish.', {
        status: 429, retryable: true,
      });
    }

    const operation = record({
      id: nextId(),
      sessionId: session.id,
      generation: session.generation,
      idempotencyKey,
      type: request.type,
      parameters: request.parameters,
      status: 'queued',
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
    });
    idempotency.set(idempotencyKey, { fingerprint, operationId: operation.id });
    if (idempotency.size > RUNTIME_LIMITS.idempotencyKeys) {
      idempotency.delete(idempotency.keys().next().value);
    }

    if (LIFECYCLE_OPERATIONS.includes(operation.type)) {
      runLifecycle(operation);
    } else {
      emit('operation.queued', { operation }, { operationId: operation.id });
      if (operation.type === 'pipeline.cancel') {
        cancelPipeline(operation, activePipeline.id).catch(onError);
      } else if (readOnly) {
        execute(operation);
      } else {
        mutationChain = mutationChain.then(() => execute(operation)).catch(onError);
      }
    }
    return clone(registry.get(operation.id));
  }

  return {
    lab,
    fixtureId,
    mode,
    backend: executor.backend ?? 'Execution backend',
    capabilities: () => [...supported],
    async start({ restore = null } = {}) {
      if (restore) {
        const hydrated = hydrateSession(restore, { now: new Date(clock.now()).toISOString() });
        if (hydrated.labId !== lab.id || hydrated.fixtureId !== fixtureId || hydrated.mode !== mode) {
          throw new DomainError('CHECKPOINT_MISMATCH', 'The saved session belongs to another lab, fixture, or mode.', { status: 409 });
        }
        session = hydrated;
        await executor.restore?.({ session: clone(session) });
        if (['active', 'degraded'].includes(session.status)) {
          // Recording the restore re-evaluates state-based objectives against the hydrated snapshot.
          emitLogs([{
            serviceId: null, stream: 'system', level: 'info', at: timestamp(),
            message: 'Session restored from a browser checkpoint; interrupted work was cancelled.',
          }]);
        }
        return clone(session);
      }
      const sessionId = nextId();
      const createdAt = new Date(clock.now()).toISOString();
      const setup = await executor.setup({ labId: lab.id, fixtureId, sessionId, generation: 1, now: createdAt });
      let first = true;
      session = createSession({
        manifest: lab,
        mode,
        fixtureId,
        resources: setup.resources,
        pipeline: setup.pipeline ?? emptyPipeline(),
        now: () => createdAt,
        nextId: () => {
          if (first) {
            first = false;
            return sessionId;
          }
          return nextId();
        },
      });
      emit('session.status-changed', { status: 'active' });
      if (setup.logs?.length) {
        emitLogs(setup.logs);
      }
      return clone(session);
    },
    getSession: () => session,
    getEvents: () => events,
    getOperation: (operationId) => clone(registry.get(operationId)),
    settled(operationId) {
      const operation = registry.get(operationId);
      if (!operation) {
        return Promise.reject(new DomainError('UNKNOWN_OPERATION', 'The operation is unknown.', { status: 404 }));
      }
      if (TERMINAL.includes(operation.status)) {
        return Promise.resolve(clone(operation));
      }
      return new Promise((resolve) => {
        waiters.set(operationId, [...(waiters.get(operationId) ?? []), resolve]);
      });
    },
    submit,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    listenerCount: () => listeners.size,
    dispose() {
      clearTimers();
      for (const { controller } of active.values()) {
        controller.abort();
      }
      listeners.clear();
    },
  };
}
