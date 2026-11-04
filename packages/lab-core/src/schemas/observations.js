import { z } from 'zod';
import {
  generationSchema, identifierSchema, portSchema, revisionSchema,
  sourceSchema, timestampSchema,
} from './shared.js';

export const LIMITS = Object.freeze({
  probeHistory: 20,
  probeBodyBytes: 16 * 1024,
  logEntries: 500,
  logBytes: 256 * 1024,
  logLineBytes: 8 * 1024,
  logBatch: 50,
});

// C0 and C1 controls except horizontal tab; log text must be sanitized before ingestion.
// eslint-disable-next-line no-control-regex
export const UNSAFE_TEXT = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/;

function utf8Bytes(value) {
  return new TextEncoder().encode(value).length;
}

export function jsonBytes(value) {
  return utf8Bytes(JSON.stringify(value) ?? '');
}

export const probePathSchema = z.enum(['/health', '/version']);

/** Probe outcome as reported by a driver; provenance is added from the event. */
export const probeObservationSchema = z.strictObject({
  serviceId: identifierSchema,
  kind: z.enum(['health', 'version']),
  port: portSchema,
  path: probePathSchema,
  ok: z.boolean(),
  statusCode: z.int().min(100).max(599).nullable(),
  body: z.json().nullable(),
  error: z.string().min(1).max(1000).nullable(),
  durationMs: z.int().nonnegative().max(600_000),
}).superRefine((probe, context) => {
  if (probe.body !== null && jsonBytes(probe.body) > LIMITS.probeBodyBytes) {
    context.addIssue({ code: 'custom', message: 'Probe response body exceeds 16 KiB.' });
  }
  if (probe.ok && (probe.statusCode === null || probe.error !== null)) {
    context.addIssue({ code: 'custom', message: 'Successful probes require a status code and no error.' });
  }
  if (!probe.ok && probe.statusCode === null && probe.error === null) {
    context.addIssue({ code: 'custom', message: 'Failed probes require a status code or an error.' });
  }
  if ((probe.kind === 'health') !== (probe.path === '/health')) {
    context.addIssue({ code: 'custom', message: 'Probe kind and path do not match.' });
  }
});

export const probeRecordSchema = z.strictObject({
  ...probeObservationSchema.shape,
  eventId: z.string().min(1).max(512),
  operationId: identifierSchema.nullable(),
  generation: generationSchema,
  revision: revisionSchema,
  source: sourceSchema,
  observedAt: timestampSchema,
});

export const logLineSchema = z.strictObject({
  serviceId: identifierSchema.nullable(),
  stream: z.enum(['stdout', 'stderr', 'system']),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string().min(1)
    .refine((value) => utf8Bytes(value) <= LIMITS.logLineBytes, 'Log line exceeds 8 KiB.')
    .refine((value) => !UNSAFE_TEXT.test(value), 'Log line contains control characters.'),
  at: timestampSchema,
});

export const logEntrySchema = z.strictObject({
  ...logLineSchema.shape,
  seq: z.int().positive(),
  source: sourceSchema,
});

export const logBufferSchema = z.strictObject({
  entries: z.array(logEntrySchema).max(LIMITS.logEntries),
  dropped: z.int().nonnegative(),
  bytes: z.int().nonnegative().max(LIMITS.logBytes),
  nextSeq: z.int().positive(),
});

export function emptyLogBuffer() {
  return { entries: [], dropped: 0, bytes: 0, nextSeq: 1 };
}

/** Append entries, then evict the oldest ones until count and byte bounds hold. */
export function appendLogEntries(buffer, lines, source) {
  let { nextSeq, bytes, dropped } = buffer;
  const entries = [...buffer.entries];
  for (const line of lines) {
    entries.push({ ...line, seq: nextSeq, source });
    nextSeq += 1;
    bytes += utf8Bytes(line.message);
  }
  while (entries.length > LIMITS.logEntries || bytes > LIMITS.logBytes) {
    const removed = entries.shift();
    bytes -= utf8Bytes(removed.message);
    dropped += 1;
  }
  return { entries, dropped, bytes, nextSeq };
}
