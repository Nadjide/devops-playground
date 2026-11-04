import { z } from 'zod';
import {
  generationSchema, identifierSchema, operationErrorSchema, portSchema,
  slugSchema, timestampSchema,
} from './shared.js';

const serviceParameters = z.strictObject({ serviceId: identifierSchema });
const emptyParameters = z.strictObject({});

const parameterSchemas = {
  'container.start': serviceParameters,
  'container.stop': serviceParameters,
  'container.restart': serviceParameters,
  'container.inspect': serviceParameters,
  'container.logs': serviceParameters.extend({ tail: z.int().min(1).max(200).default(50) }),
  'service.configure': serviceParameters.extend({ appPort: portSchema }),
  'health.probe': serviceParameters,
  'version.probe': serviceParameters,
  'pipeline.run': z.strictObject({ releaseId: slugSchema }),
  'pipeline.rollback': emptyParameters,
  'pipeline.cancel': emptyParameters,
  'session.reset': emptyParameters,
  'session.end': emptyParameters,
};

export const operationTypeSchema = z.enum(Object.keys(parameterSchemas));

function operationVariants(fields) {
  return Object.entries(parameterSchemas).map(([type, parameters]) => z.strictObject({
    ...fields,
    type: z.literal(type),
    parameters,
  }));
}

export const operationRequestSchema = z.discriminatedUnion('type', operationVariants({
  generation: generationSchema,
}));

export const operationSchema = z.discriminatedUnion('type', operationVariants({
  id: identifierSchema,
  sessionId: identifierSchema,
  generation: generationSchema,
  idempotencyKey: identifierSchema,
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  startedAt: timestampSchema.nullable(),
  finishedAt: timestampSchema.nullable(),
  result: z.json().nullable(),
  error: operationErrorSchema.nullable(),
})).superRefine((operation, context) => {
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(operation.status);
  if (terminal !== (operation.finishedAt !== null)) {
    context.addIssue({ code: 'custom', message: 'Terminal operations require a finish time.' });
  }
  if (operation.status === 'queued' && operation.startedAt !== null) {
    context.addIssue({ code: 'custom', message: 'Queued operations have no start time.' });
  }
  if (['running', 'succeeded'].includes(operation.status) && operation.startedAt === null) {
    context.addIssue({ code: 'custom', message: 'Running and successful operations require a start time.' });
  }
  if (operation.status === 'failed' ? operation.error === null : operation.error !== null) {
    context.addIssue({ code: 'custom', message: 'Only failed operations require an error.' });
  }
  if (operation.startedAt && operation.finishedAt &&
      Date.parse(operation.finishedAt) < Date.parse(operation.startedAt)) {
    context.addIssue({ code: 'custom', message: 'Finish time precedes start time.' });
  }
});
