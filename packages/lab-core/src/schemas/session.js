import { z } from 'zod';
import {
  generationSchema, identifierSchema, portSchema, revisionSchema,
  sessionStatusSchema, slugSchema, sourceSchema, timestampSchema,
} from './shared.js';
import { operationSchema } from './operations.js';
import { missionProgressSchema } from './missions.js';
import { LIMITS, logBufferSchema, probeRecordSchema } from './observations.js';

export const containerObservationSchema = z.strictObject({
  state: z.enum(['created', 'starting', 'running', 'stopped', 'exited', 'removing', 'removed', 'unknown']),
  health: z.enum(['unknown', 'starting', 'healthy', 'unhealthy']),
  image: z.string().min(1).max(256).nullable(),
  exitCode: z.int().nullable(),
  startedAt: timestampSchema.nullable(),
  ports: z.array(z.strictObject({
    containerPort: portSchema,
    hostPort: portSchema.nullable(),
  })).max(8),
  source: sourceSchema,
  observedAt: timestampSchema,
  unavailableReason: z.string().min(1).max(1000).nullable(),
});

export const resourceSchema = z.strictObject({
  id: identifierSchema,
  sessionId: identifierSchema,
  generation: generationSchema,
  serviceId: identifierSchema,
  kind: z.literal('container'),
  desired: z.strictObject({
    image: z.string().min(1).max(256),
    appPort: portSchema,
    expectedProbePort: portSchema,
  }),
  observed: containerObservationSchema,
});

export const sessionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: identifierSchema,
  mode: z.enum(['demo', 'local']),
  labId: slugSchema,
  revision: revisionSchema,
  generation: generationSchema,
  eventEpoch: identifierSchema,
  status: sessionStatusSchema,
  resources: z.array(resourceSchema).max(3),
  operations: z.array(operationSchema).max(111),
  mission: missionProgressSchema,
  probes: z.array(probeRecordSchema).max(LIMITS.probeHistory),
  logs: logBufferSchema,
  lastEventSequence: revisionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine((session, context) => {
  if (Date.parse(session.updatedAt) < Date.parse(session.createdAt)) {
    context.addIssue({ code: 'custom', message: 'Update time precedes session creation.' });
  }
  if (session.mission.id !== session.labId) {
    context.addIssue({ code: 'custom', message: 'Mission does not match the active lab.' });
  }
  for (const field of ['resources', 'operations']) {
    const items = session[field];
    if (new Set(items.map((item) => item.id)).size !== items.length) {
      context.addIssue({ code: 'custom', message: `Duplicate ${field} ID.` });
    }
    for (const item of items) {
      if (item.sessionId !== session.id || item.generation !== session.generation) {
        context.addIssue({ code: 'custom', message: `${field} ownership does not match the session.` });
      }
    }
  }
  if (new Set(session.resources.map((resource) => resource.serviceId)).size !== session.resources.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate logical service ID.' });
  }
  for (const operation of session.operations) {
    const serviceId = operation.parameters.serviceId;
    if (serviceId && !session.resources.some((resource) => resource.serviceId === serviceId)) {
      context.addIssue({ code: 'custom', message: 'Operation references an unknown service.' });
    }
  }
  for (const objective of session.mission.objectives) {
    if (objective.evidence && (objective.evidence.generation !== session.generation ||
        objective.evidence.revision > session.revision)) {
      context.addIssue({ code: 'custom', message: 'Objective evidence belongs to another generation or revision.' });
    }
  }
  for (const probe of session.probes) {
    if (probe.generation !== session.generation || probe.revision > session.revision) {
      context.addIssue({ code: 'custom', message: 'Probe evidence belongs to another generation or revision.' });
    }
  }
  if (session.mode === 'demo' && session.resources.some((resource) => resource.observed.source !== 'simulator')) {
    context.addIssue({ code: 'custom', message: 'Demo resources require simulator provenance.' });
  }
  if (session.mode === 'local' && session.resources.some((resource) => resource.observed.source === 'simulator')) {
    context.addIssue({ code: 'custom', message: 'Local resources cannot use simulator provenance.' });
  }
});
