import { createPipelineRecorder, OperationFailure } from '@devops-playground/lab-core';

export const LOCAL_OPERATIONS = Object.freeze([
  'container.start', 'container.stop', 'container.restart', 'container.inspect', 'container.logs',
  'service.configure', 'health.probe', 'version.probe',
  'pipeline.run', 'pipeline.rollback', 'pipeline.cancel',
  'session.reset', 'session.end',
]);

const TIMEOUTS = { setup: 6 * 60_000, execute: 2 * 60_000, pipeline: 12 * 60_000, teardown: 60_000 };

/** Runner failure surfaced through the API envelope (status, code, retryable). */
export class RunnerFailure extends Error {
  constructor({ code, message, retryable = true }, status = 503) {
    super(message);
    this.name = 'RunnerFailure';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Local execution backend: every operation is performed by the internal runner
 * against real Docker resources and streamed back as observations. There is
 * no simulated fallback when the runner or daemon fails.
 */
export function createLocalExecutorFactory({ runner }) {
  const operations = runner ? [...LOCAL_OPERATIONS] : [];
  return {
    operations,
    factory() {
      if (!runner) {
        throw new Error('Local execution requires a runner.');
      }
      return {
        backend: 'Local Docker',
        supportedOperations: operations,
        async setup({ labId, fixtureId, sessionId, generation }) {
          const outcome = await runner.stream(`/v1/sessions/${sessionId}/setup`, { generation, labId, fixtureId }, { timeoutMs: TIMEOUTS.setup });
          if (outcome.failure) {
            throw new RunnerFailure(outcome.failure);
          }
          return outcome.result;
        },
        async execute(operation, ctx) {
          const session = ctx.session();
          const pipelineRun = operation.type === 'pipeline.run' || operation.type === 'pipeline.rollback';
          let outcome;
          try {
            outcome = await runner.stream(`/v1/sessions/${session.id}/execute`, {
              generation: session.generation,
              labId: session.labId,
              fixtureId: session.fixtureId,
              resources: session.resources,
              pipeline: session.pipeline,
              operation: { id: operation.id, type: operation.type, parameters: operation.parameters },
            }, {
              timeoutMs: pipelineRun ? TIMEOUTS.pipeline : TIMEOUTS.execute,
              signal: ctx.signal,
              onRecord(record) {
                if (record.kind === 'emit') {
                  ctx.emit(record.type, record.payload, { source: record.source === 'probe' ? 'probe' : 'docker' });
                } else if (record.kind === 'logs') {
                  ctx.emitLogs(record.lines);
                }
              },
            });
          } catch (error) {
            if (ctx.signal.aborted && pipelineRun) {
              // The runner stops silently on disconnect; record the cancelled run here.
              const run = ctx.session().pipeline.runs.find((item) => item.id === operation.id && item.status === 'running');
              if (run) {
                createPipelineRecorder(ctx, { source: 'docker' }).finish(run.id, { status: 'cancelled' }, ctx.reconcile);
              }
            }
            throw error;
          }
          if (outcome.failure) {
            throw new OperationFailure(outcome.failure.code, outcome.failure.message, { retryable: outcome.failure.retryable });
          }
          return outcome.result;
        },
        async teardown({ session }) {
          const outcome = await runner.stream(`/v1/sessions/${session.id}/teardown`, {}, { timeoutMs: TIMEOUTS.teardown });
          if (outcome.failure) {
            throw new RunnerFailure(outcome.failure);
          }
          return outcome.result;
        },
      };
    },
  };
}
