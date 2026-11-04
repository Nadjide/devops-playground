import { z } from 'zod';
import { identifierSchema, slugSchema, sourceSchema, timestampSchema } from './shared.js';
import { LIMITS, UNSAFE_TEXT } from './observations.js';

export const STAGE_IDS = Object.freeze(['validate', 'test', 'build', 'deploy', 'verify']);
export const PIPELINE_LIMITS = Object.freeze({ runs: 5, stageLogLines: 40 });

const releaseRefSchema = z.strictObject({
  releaseId: slugSchema,
  image: z.string().min(1).max(256),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
});

const logLine = z.string().min(1).max(LIMITS.logLineBytes)
  .refine((value) => !UNSAFE_TEXT.test(value), 'Stage log contains control characters.');

export const stageSchema = z.strictObject({
  id: z.enum(STAGE_IDS),
  status: z.enum(['pending', 'running', 'passed', 'failed', 'skipped', 'cancelled']),
  startedAt: timestampSchema.nullable(),
  finishedAt: timestampSchema.nullable(),
  durationMs: z.int().nonnegative().nullable(),
  exitCode: z.int().nullable(),
  logs: z.array(logLine).max(PIPELINE_LIMITS.stageLogLines),
  source: sourceSchema.nullable(),
});

export const pipelineRunSchema = z.strictObject({
  id: identifierSchema,
  kind: z.enum(['deploy', 'rollback']),
  release: releaseRefSchema,
  status: z.enum(['running', 'passed', 'failed', 'cancelled']),
  stages: z.array(stageSchema).length(STAGE_IDS.length),
  startedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
  failureReason: z.string().min(1).max(1000).nullable(),
}).superRefine((run, context) => {
  if (run.stages.some((stage, index) => stage.id !== STAGE_IDS[index])) {
    context.addIssue({ code: 'custom', message: 'Stages must follow the fixed graph.' });
  }
  if ((run.status === 'running') !== (run.finishedAt === null)) {
    context.addIssue({ code: 'custom', message: 'Only running pipeline runs lack a finish time.' });
  }
  if (run.status === 'failed' && run.failureReason === null) {
    context.addIssue({ code: 'custom', message: 'Failed runs require a failure reason.' });
  }
});

export const pipelineSchema = z.strictObject({
  knownGood: releaseRefSchema.nullable(),
  deployed: releaseRefSchema.extend({ status: z.enum(['verified', 'failed', 'unverified']) }).nullable(),
  runs: z.array(pipelineRunSchema).max(PIPELINE_LIMITS.runs),
}).superRefine((pipeline, context) => {
  if (pipeline.runs.filter((run) => run.status === 'running').length > 1) {
    context.addIssue({ code: 'custom', message: 'Only one pipeline run can be active.' });
  }
});
