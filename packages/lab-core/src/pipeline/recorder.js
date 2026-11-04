import { PIPELINE_LIMITS, STAGE_IDS } from '../schemas/pipeline.js';
import { sanitizeLogMessage } from '../commands/sanitize.js';
import { releaseRef } from '../fixtures/releases.js';

export function createRunRecord({ id, kind, release, startedAt }) {
  return {
    id,
    kind,
    release: releaseRef(release),
    status: 'running',
    stages: STAGE_IDS.map((stageId) => ({
      id: stageId, status: 'pending', startedAt: null, finishedAt: null,
      durationMs: null, exitCode: null, logs: [], source: null,
    })),
    startedAt,
    finishedAt: null,
    failureReason: null,
  };
}

function boundedLogs(existing, lines) {
  const all = [...existing, ...lines.map((line) => sanitizeLogMessage(line))];
  if (all.length <= PIPELINE_LIMITS.stageLogLines) {
    return all;
  }
  const kept = all.slice(-(PIPELINE_LIMITS.stageLogLines - 1));
  return [`[${all.length - kept.length} earlier lines omitted]`, ...kept];
}

/**
 * Records one pipeline run through `pipeline.updated` events. Every driver
 * uses it so stage semantics stay identical: a failed or cancelled stage marks
 * the stages after it skipped, and only a verified deployment becomes the
 * known-good release.
 */
export function createPipelineRecorder(ctx, { source }) {
  const update = (change, emit = ctx.emit) => emit('pipeline.updated', change(ctx.session().pipeline));
  const updateRun = (runId, change, emit) => update((pipeline) => ({
    ...pipeline,
    runs: pipeline.runs.map((run) => (run.id === runId ? change(run) : run)),
  }), emit);
  const updateStage = (runId, stageId, change, emit) => updateRun(runId, (run) => ({
    ...run,
    stages: run.stages.map((stage) => (stage.id === stageId ? change(stage) : stage)),
  }), emit);
  const duration = (stage, finishedAt) => (stage.startedAt
    ? Math.max(0, Date.parse(finishedAt) - Date.parse(stage.startedAt))
    : null);

  return {
    start(run) {
      update((pipeline) => ({ ...pipeline, runs: [...pipeline.runs, run].slice(-PIPELINE_LIMITS.runs) }));
    },
    stageStart(runId, stageId) {
      updateStage(runId, stageId, (stage) => ({ ...stage, status: 'running', startedAt: ctx.now(), source }));
    },
    stageLog(runId, stageId, lines) {
      updateStage(runId, stageId, (stage) => ({ ...stage, logs: boundedLogs(stage.logs, lines) }));
    },
    stageFinish(runId, stageId, { status, exitCode = null, logs = [] }) {
      const finishedAt = ctx.now();
      updateStage(runId, stageId, (stage) => ({
        ...stage,
        status,
        exitCode,
        finishedAt,
        durationMs: duration(stage, finishedAt),
        logs: boundedLogs(stage.logs, logs),
      }));
    },
    skip(runId, stageId, reason) {
      updateStage(runId, stageId, (stage) => ({ ...stage, status: 'skipped', logs: boundedLogs(stage.logs, [reason]), source }));
    },
    setReleases(change) {
      update((pipeline) => ({ ...pipeline, ...change(pipeline) }));
    },
    /** Close the run; `emit` lets a cancelled run reconcile after its abort signal fired. */
    finish(runId, { status, failureReason = null }, emit = ctx.emit) {
      const finishedAt = ctx.now();
      updateRun(runId, (run) => ({
        ...run,
        status,
        finishedAt,
        failureReason,
        stages: run.stages.map((stage) => {
          if (stage.status === 'running') {
            const closed = status === 'cancelled' ? 'cancelled' : 'failed';
            return { ...stage, status: closed, finishedAt, durationMs: duration(stage, finishedAt) };
          }
          return stage.status === 'pending' ? { ...stage, status: 'skipped' } : stage;
        }),
      }), emit);
    },
  };
}

/** Cancellation is safe only while the deploy stage has not touched the service. */
export function isCancellable(run) {
  return run?.status === 'running' && run.stages.find((stage) => stage.id === 'deploy').status === 'pending';
}
