import { z } from 'zod';
import { sessionSchema } from '../schemas/session.js';
import { timestampSchema } from '../schemas/shared.js';

export const CHECKPOINT_VERSION = 1;
export const MAX_CHECKPOINT_BYTES = 512 * 1024;

const checkpointSchema = z.strictObject({
  checkpointVersion: z.literal(CHECKPOINT_VERSION),
  savedAt: timestampSchema,
  session: sessionSchema,
});

const encoder = new TextEncoder();

/** Serialize a demo session; refuses checkpoints above the 512 KiB bound. */
export function serializeCheckpoint(session, { now = () => new Date().toISOString() } = {}) {
  if (session.mode !== 'demo') {
    return { ok: false, reason: 'unsupported', message: 'Only demo sessions are saved in the browser.' };
  }
  const text = JSON.stringify({ checkpointVersion: CHECKPOINT_VERSION, savedAt: now(), session });
  const bytes = encoder.encode(text).length;
  if (bytes > MAX_CHECKPOINT_BYTES) {
    return { ok: false, reason: 'oversized', message: `The checkpoint is ${Math.ceil(bytes / 1024)} KiB, above the 512 KiB limit.` };
  }
  return { ok: true, text, bytes };
}

/**
 * Validate stored text before any hydration. Every failure is typed so the
 * workbench can offer an explicit recovery choice.
 */
export function parseCheckpoint(text) {
  if (text === null || text === undefined) {
    return { ok: false, reason: 'empty', message: 'No saved progress.' };
  }
  if (encoder.encode(text).length > MAX_CHECKPOINT_BYTES) {
    return { ok: false, reason: 'oversized', message: 'Saved progress exceeds the 512 KiB limit.' };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'malformed', message: 'Saved progress is not valid JSON.' };
  }
  if (data?.checkpointVersion !== CHECKPOINT_VERSION || data?.session?.schemaVersion !== 1) {
    return {
      ok: false,
      reason: 'incompatible',
      message: `Saved progress uses checkpoint version ${data?.checkpointVersion ?? 'unknown'}, but this build reads version ${CHECKPOINT_VERSION}.`,
    };
  }
  const parsed = checkpointSchema.safeParse(data);
  if (!parsed.success || parsed.data.session.mode !== 'demo') {
    return { ok: false, reason: 'invalid', message: 'Saved progress failed validation.' };
  }
  return { ok: true, checkpoint: parsed.data };
}

/**
 * Prepare a restored snapshot for a fresh runtime. Work that was in flight when
 * the page closed cannot resume, so it is reconciled as cancelled or interrupted.
 */
export function hydrateSession(snapshot, { now }) {
  const session = sessionSchema.parse(snapshot);
  const at = new Date(Math.max(Date.parse(now), Date.parse(session.updatedAt))).toISOString();
  const operations = session.operations.map((operation) => (['queued', 'running'].includes(operation.status)
    ? { ...operation, status: 'cancelled', finishedAt: at, result: null, error: null }
    : operation));
  const resources = session.resources.map((resource) => {
    const { observed, desired } = resource;
    if (observed.state === 'starting') {
      return {
        ...resource,
        observed: {
          ...observed, state: 'stopped', health: 'unknown', exitCode: null, startedAt: null, observedAt: at,
          unavailableReason: 'Startup was interrupted by a page reload.',
        },
      };
    }
    if (observed.state === 'running' && observed.health === 'starting') {
      const health = desired.appPort === desired.expectedProbePort ? 'healthy' : 'unhealthy';
      return { ...resource, observed: { ...observed, health, observedAt: at } };
    }
    return resource;
  });
  const pipeline = {
    ...session.pipeline,
    runs: session.pipeline.runs.map((run) => (run.status !== 'running' ? run : {
      ...run,
      status: 'cancelled',
      finishedAt: at,
      stages: run.stages.map((stage) => {
        if (stage.status === 'running') {
          return { ...stage, status: 'cancelled', finishedAt: at };
        }
        return stage.status === 'pending' ? { ...stage, status: 'skipped' } : stage;
      }),
    })),
  };
  const status = ['active', 'degraded', 'ended'].includes(session.status) ? session.status : 'degraded';
  return sessionSchema.parse({ ...session, status, operations, resources, pipeline, updatedAt: at });
}
