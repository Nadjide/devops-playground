import { z } from 'zod';
import {
  generationSchema, identifierSchema, portSchema, sessionStatusSchema,
  sourceSchema, timestampSchema,
} from './shared.js';
import { operationSchema } from './operations.js';
import { missionProgressSchema } from './missions.js';
import { containerObservationSchema, resourceSchema } from './session.js';
import { LIMITS, logLineSchema, probeObservationSchema } from './observations.js';
import { pipelineSchema } from './pipeline.js';
import {
  namespaceObservationSchema, objectObservationSchema, roundTripObservationSchema, storageStateSchema,
  workloadStorageSchema,
} from './storage.js';

const payloadSchemas = {
  'session.status-changed': z.strictObject({ status: sessionStatusSchema }),
  'session.reset': z.strictObject({
    resources: z.array(resourceSchema).max(3),
    mission: missionProgressSchema,
    pipeline: pipelineSchema,
    storage: storageStateSchema.nullable(),
  }),
  'pipeline.updated': pipelineSchema,
  'resource.observed': containerObservationSchema.omit({ source: true, observedAt: true })
    .partial().extend({ resourceId: identifierSchema, state: containerObservationSchema.shape.state }),
  'resource.configured': z.strictObject({
    resourceId: identifierSchema,
    appPort: portSchema.optional(),
    image: z.string().min(1).max(256).optional(),
    storage: workloadStorageSchema.optional(),
  }).refine((change) => change.appPort !== undefined || change.image !== undefined || change.storage !== undefined,
    'A configuration change needs an appPort, an image, or a storage target.'),
  'storage.namespace-observed': namespaceObservationSchema,
  'storage.object-observed': objectObservationSchema,
  'storage.roundtrip-completed': roundTripObservationSchema,
  'mission.updated': missionProgressSchema,
  'probe.completed': probeObservationSchema,
  'log.appended': z.strictObject({ entries: z.array(logLineSchema).min(1).max(LIMITS.logBatch) }),
  'operation.queued': z.strictObject({ operation: operationSchema }),
  'operation.started': z.strictObject({ operation: operationSchema }),
  'operation.succeeded': z.strictObject({ operation: operationSchema }),
  'operation.failed': z.strictObject({ operation: operationSchema }),
  'operation.cancelled': z.strictObject({ operation: operationSchema }),
};

export const eventSchema = z.discriminatedUnion('type', Object.entries(payloadSchemas)
  .map(([type, payload]) => z.strictObject({
    schemaVersion: z.literal(1),
    id: z.string().min(1).max(512),
    sessionId: identifierSchema,
    generation: generationSchema,
    eventEpoch: identifierSchema,
    sequence: z.int().positive(),
    revision: z.int().positive(),
    type: z.literal(type),
    occurredAt: timestampSchema,
    operationId: identifierSchema.nullable(),
    source: sourceSchema,
    payload,
  }))).superRefine((event, context) => {
  if (event.id !== `${event.sessionId}:${event.eventEpoch}:${event.sequence}`) {
    context.addIssue({ code: 'custom', message: 'Event ID does not match its session, epoch, and sequence.' });
  }
  if (event.type.startsWith('operation.')) {
    const operation = event.payload.operation;
    const expectedStatus = event.type === 'operation.started' ? 'running' : event.type.slice(10);
    if (operation.status !== expectedStatus || operation.id !== event.operationId ||
        operation.sessionId !== event.sessionId || operation.generation !== event.generation) {
      context.addIssue({ code: 'custom', message: 'Operation event identity or status mismatch.' });
    }
  }
});
