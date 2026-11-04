import { z } from 'zod';
import {
  generationSchema, identifierSchema, revisionSchema, sourceSchema, timestampSchema,
} from './shared.js';

export const STORAGE_PROVIDERS = Object.freeze(['aws-s3']);

export const STORAGE_LIMITS = Object.freeze({
  namespaces: 8,
  objects: 50,
  objectBytes: 64 * 1024,
  // Simulated content lives in the snapshot, so it shares the checkpoint budget.
  simulatedBytes: 128 * 1024,
  previewBytes: 4 * 1024,
  roundTrips: 10,
  keyLength: 128,
});

const encoder = new TextEncoder();
export const utf8Bytes = (value) => encoder.encode(value).length;

// eslint-disable-next-line no-control-regex -- object text keeps tab, newline, and carriage return only.
const UNSAFE_CONTENT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

export const providerSchema = z.enum(STORAGE_PROVIDERS);

/** Shape shared by S3 buckets and Blob containers; provider rules are applied separately. */
export const namespaceNameSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
  'Storage names use 3 to 63 lowercase letters, digits, dots, or hyphens.');

/**
 * Requested names: a safe character set only, so the provider profile can
 * answer with its own naming error (S3 InvalidBucketName, for example).
 */
export const namespaceInputSchema = z.string().regex(/^[A-Za-z0-9._-]{1,63}$/,
  'Storage names are 1 to 63 letters, digits, dots, hyphens, or underscores.');

/** Flat key grammar: no slashes, no parent segments, never a filesystem path. */
export const objectKeySchema = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    'Object keys are 1 to 128 letters, digits, dots, hyphens, or underscores, starting with a letter or digit.')
  .refine((key) => !key.includes('..'), 'Object keys cannot contain "..".');

export const objectContentSchema = z.string()
  .refine((value) => utf8Bytes(value) <= STORAGE_LIMITS.objectBytes, 'Object content is limited to 64 KiB of UTF-8 text.')
  .refine((value) => !UNSAFE_CONTENT.test(value), 'Object content must be plain text without control characters.');

/** Endpoint identity as configured; whether it is approved is decided by the provider profile. */
export const endpointSchema = z.string().max(200).regex(/^https?:\/\/[a-z0-9.-]{1,100}(:\d{1,5})?(\/[A-Za-z0-9._-]{0,64})?$/,
  'Endpoints are http(s) URLs with a host, an optional port, and an optional single path segment.');

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const workloadStorageSchema = z.strictObject({
  namespace: namespaceNameSchema,
  endpoint: endpointSchema,
});

const namespaceSchema = z.strictObject({
  name: namespaceNameSchema,
  owned: z.boolean(),
  createdAt: timestampSchema.nullable(),
  source: sourceSchema,
  observedAt: timestampSchema,
});

const objectSchema = z.strictObject({
  namespace: namespaceNameSchema,
  key: objectKeySchema,
  bytes: z.int().nonnegative().max(STORAGE_LIMITS.objectBytes),
  sha256: sha256Schema,
  updatedAt: timestampSchema,
  writer: z.enum(['console', 'workload', 'fixture']),
  source: sourceSchema,
  observedAt: timestampSchema,
  // Only the browser simulator keeps content; real backends hold their own data.
  content: objectContentSchema.optional(),
});

/** Result of the workload's own write-then-read check, as reported by a driver. */
export const roundTripObservationSchema = z.strictObject({
  serviceId: identifierSchema,
  ok: z.boolean(),
  provider: providerSchema,
  endpoint: endpointSchema,
  namespace: namespaceNameSchema,
  key: objectKeySchema,
  bytes: z.int().nonnegative().max(STORAGE_LIMITS.objectBytes),
  expectedSha256: sha256Schema,
  observedSha256: sha256Schema.nullable(),
  statusCode: z.int().min(100).max(599).nullable(),
  error: z.string().min(1).max(1000).nullable(),
  durationMs: z.int().nonnegative().max(600_000),
}).superRefine((check, context) => {
  if (check.ok && (check.observedSha256 !== check.expectedSha256 || check.error !== null)) {
    context.addIssue({ code: 'custom', message: 'A successful round trip reads back the payload it wrote.' });
  }
  if (!check.ok && check.error === null) {
    context.addIssue({ code: 'custom', message: 'A failed round trip requires an error.' });
  }
});

export const roundTripRecordSchema = z.strictObject({
  ...roundTripObservationSchema.shape,
  eventId: z.string().min(1).max(512),
  operationId: identifierSchema.nullable(),
  generation: generationSchema,
  revision: revisionSchema,
  source: sourceSchema,
  observedAt: timestampSchema,
});

export const storageStateSchema = z.strictObject({
  provider: providerSchema,
  endpoint: endpointSchema,
  namespaces: z.array(namespaceSchema).max(STORAGE_LIMITS.namespaces),
  objects: z.array(objectSchema).max(STORAGE_LIMITS.objects),
  roundTrips: z.array(roundTripRecordSchema).max(STORAGE_LIMITS.roundTrips),
}).superRefine((storage, context) => {
  const names = storage.namespaces.map((namespace) => namespace.name);
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate storage namespace.' });
  }
  const keys = storage.objects.map((object) => `${object.namespace}/${object.key}`);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate storage object.' });
  }
  if (storage.objects.some((object) => !names.includes(object.namespace))) {
    context.addIssue({ code: 'custom', message: 'Storage objects must belong to an observed namespace.' });
  }
  const simulated = storage.objects.reduce((total, object) => total + (object.content === undefined ? 0 : object.bytes), 0);
  if (simulated > STORAGE_LIMITS.simulatedBytes) {
    context.addIssue({ code: 'custom', message: 'Simulated storage content exceeds 128 KiB.' });
  }
  for (const object of storage.objects) {
    if (object.content !== undefined && utf8Bytes(object.content) !== object.bytes) {
      context.addIssue({ code: 'custom', message: 'Simulated object size does not match its content.' });
    }
  }
});

/** Observation payloads; the reducer adds provenance from the event. */
export const namespaceObservationSchema = z.discriminatedUnion('state', [
  z.strictObject({
    name: namespaceNameSchema,
    state: z.literal('present'),
    owned: z.boolean(),
    createdAt: timestampSchema.nullable(),
  }),
  z.strictObject({ name: namespaceNameSchema, state: z.literal('absent') }),
]);

export const objectObservationSchema = z.discriminatedUnion('state', [
  z.strictObject({
    namespace: namespaceNameSchema,
    key: objectKeySchema,
    state: z.literal('present'),
    bytes: z.int().nonnegative().max(STORAGE_LIMITS.objectBytes),
    sha256: sha256Schema,
    updatedAt: timestampSchema,
    writer: z.enum(['console', 'workload', 'fixture']),
    content: objectContentSchema.optional(),
  }),
  z.strictObject({ namespace: namespaceNameSchema, key: objectKeySchema, state: z.literal('absent') }),
]);
