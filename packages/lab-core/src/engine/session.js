import { labManifestSchema } from '../schemas/missions.js';
import { sessionSchema } from '../schemas/session.js';
import { eventSchema } from '../schemas/events.js';

export class SessionStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SessionStateError';
    this.code = code;
  }
}

function requireState(condition, code, message) {
  if (!condition) {
    throw new SessionStateError(code, message);
  }
}

export function createSession({
  manifest,
  mode = 'demo',
  resources = [],
  now = () => new Date().toISOString(),
  nextId = () => globalThis.crypto.randomUUID(),
}) {
  const lab = labManifestSchema.parse(manifest);
  requireState(lab.supportedModes.includes(mode), 'UNSUPPORTED_MODE', 'The lab does not support this mode.');
  const timestamp = now();

  return sessionSchema.parse({
    schemaVersion: 1,
    id: nextId(),
    mode,
    labId: lab.id,
    revision: 0,
    generation: 1,
    eventEpoch: nextId(),
    status: 'initializing',
    resources,
    operations: [],
    mission: {
      id: lab.id,
      status: 'not-started',
      objectives: lab.objectives.map(({ id }) => ({ id, status: 'pending', evidence: null })),
    },
    lastEventSequence: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

const sessionTransitions = {
  initializing: ['active', 'degraded', 'ending'],
  active: ['resetting', 'degraded', 'ending'],
  resetting: ['degraded', 'ending'],
  degraded: ['active', 'resetting', 'ending'],
  ending: ['ended', 'degraded'],
  ended: [],
};

const operationTransitions = {
  queued: ['running', 'failed', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

function applyOperation(state, event) {
  requireState(state.status !== 'ended', 'SESSION_ENDED', 'An ended session cannot receive operation progress.');
  const incoming = event.payload.operation;
  const existing = state.operations.find((operation) => operation.id === incoming.id);

  if (event.type === 'operation.queued') {
    requireState(!existing, 'DUPLICATE_OPERATION', 'The operation ID is already registered.');
    requireState(!state.operations.some((operation) => operation.idempotencyKey === incoming.idempotencyKey),
      'DUPLICATE_IDEMPOTENCY_KEY', 'The idempotency key is already registered.');
    requireState(['active', 'initializing'].includes(state.status),
      'SESSION_UNAVAILABLE', 'The session cannot accept operations in its current state.');
    return { ...state, operations: [...state.operations, incoming] };
  }

  requireState(existing, 'UNKNOWN_OPERATION', 'The operation has not been queued.');
  requireState(existing.type === incoming.type && existing.idempotencyKey === incoming.idempotencyKey &&
    Object.entries(existing.parameters).every(([key, value]) => incoming.parameters[key] === value),
  'OPERATION_IDENTITY_CHANGED', 'The queued operation identity and parameters are immutable.');

  requireState(operationTransitions[existing.status].includes(incoming.status), 'INVALID_OPERATION_TRANSITION',
    'The operation cannot enter the requested state.');
  requireState(existing.startedAt === null || existing.startedAt === incoming.startedAt,
    'OPERATION_IDENTITY_CHANGED', 'An operation start time cannot change.');

  return {
    ...state,
    operations: state.operations.map((operation) => operation.id === incoming.id ? incoming : operation),
  };
}

function applyReset(state, event) {
  requireState(state.status === 'resetting', 'RESET_NOT_STARTED', 'Enter resetting state before replacing a fixture.');
  requireState(!state.operations.some((operation) => ['queued', 'running'].includes(operation.status)),
    'OPERATIONS_ACTIVE', 'Reconcile active operations before resetting the session.');
  const mission = event.payload.mission;
  requireState(mission.id === state.labId && mission.status === 'not-started' &&
    mission.objectives.length === state.mission.objectives.length &&
    mission.objectives.every((objective) => objective.status === 'pending' && objective.evidence === null &&
      state.mission.objectives.some((previous) => previous.id === objective.id)),
  'INVALID_RESET_MISSION', 'Reset must restore the active mission with fresh pending objectives.');

  return {
    ...state,
    generation: event.generation,
    status: 'active',
    resources: event.payload.resources,
    operations: [],
    mission,
  };
}

function applyEvent(state, event) {
  if (event.type === 'session.reset') {
    return applyReset(state, event);
  }
  if (event.type === 'session.status-changed') {
    const status = event.payload.status;
    requireState(sessionTransitions[state.status].includes(status), 'INVALID_SESSION_TRANSITION',
      'The session cannot enter the requested state.');
    requireState(status !== 'ended' ||
      !state.operations.some((operation) => ['queued', 'running'].includes(operation.status)),
    'OPERATIONS_ACTIVE', 'Reconcile active operations before ending the session.');
    return { ...state, status };
  }
  if (event.type.startsWith('operation.')) {
    return applyOperation(state, event);
  }

  requireState(state.status !== 'ended', 'SESSION_ENDED', 'An ended session cannot receive resource observations.');
  const resource = state.resources.find((item) => item.id === event.payload.resourceId);
  requireState(resource, 'UNKNOWN_RESOURCE', 'The observed resource does not belong to this session.');
  const { resourceId, ...observation } = event.payload;
  return {
    ...state,
    resources: state.resources.map((item) => item.id === resourceId ? {
      ...item,
      observed: { ...item.observed, ...observation, source: event.source, observedAt: event.occurredAt },
    } : item),
  };
}

export function reduceSession(snapshot, input) {
  const state = sessionSchema.parse(snapshot);
  const event = eventSchema.parse(input);
  requireState(event.sessionId === state.id, 'FOREIGN_SESSION', 'The event belongs to another session.');

  // Reconnection and cancelled work can deliver already-consumed observations.
  if (event.eventEpoch !== state.eventEpoch || event.generation < state.generation ||
      event.sequence <= state.lastEventSequence) {
    return snapshot;
  }

  requireState(event.generation === state.generation + Number(event.type === 'session.reset'),
    'GENERATION_CONFLICT', 'Only a reset can advance the generation by one.');
  requireState(event.sequence === state.lastEventSequence + 1, 'EVENT_GAP', 'A fresh snapshot is required after an event gap.');
  requireState(event.revision === state.revision + 1, 'REVISION_CONFLICT', 'The event must advance the session revision by one.');
  requireState(Date.parse(event.occurredAt) >= Date.parse(state.updatedAt),
    'EVENT_TIME_CONFLICT', 'The event precedes the current observation time.');
  requireState(state.mode === 'demo' ? event.source === 'simulator' : event.source !== 'simulator',
    'SOURCE_CONFLICT', 'The event source does not match the execution mode.');

  return sessionSchema.parse({
    ...applyEvent(state, event),
    revision: event.revision,
    lastEventSequence: event.sequence,
    updatedAt: event.occurredAt,
  });
}

export function replaceSessionSnapshot(current, incoming) {
  const previous = sessionSchema.parse(current);
  const next = sessionSchema.parse(incoming);
  requireState(previous.id === next.id && previous.mode === next.mode && previous.labId === next.labId,
    'SNAPSHOT_IDENTITY_CHANGED', 'Snapshot replacement must preserve session identity and mode.');
  requireState(next.generation >= previous.generation &&
    Date.parse(next.updatedAt) >= Date.parse(previous.updatedAt),
  'STALE_SNAPSHOT', 'The replacement snapshot is older than current state.');
  if (previous.eventEpoch === next.eventEpoch) {
    requireState(next.revision >= previous.revision && next.lastEventSequence >= previous.lastEventSequence,
      'STALE_SNAPSHOT', 'A snapshot cannot rewind the current event epoch.');
  }
  return next;
}
