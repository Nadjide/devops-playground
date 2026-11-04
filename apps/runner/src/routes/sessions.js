import express from 'express';
import { z } from 'zod';
import { getFixture, getLabManifest, operationRequestSchema, pipelineSchema, resourceSchema } from '@devops-playground/lab-core';
import { errorBody } from '../http.js';
import { DriverFailure } from '../docker/lab-driver.js';
import { classifyDockerError } from '../docker/diagnostics.js';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const sessionContext = {
  generation: z.int().positive(),
  labId: slug,
  fixtureId: slug,
};
const setupSchema = z.strictObject(sessionContext);
const executeSchema = z.strictObject({
  ...sessionContext,
  resources: z.array(resourceSchema).max(3),
  pipeline: pipelineSchema.optional(),
  operation: z.strictObject({
    id: identifier,
    type: z.string(),
    parameters: z.record(z.string(), z.unknown()),
  }),
});
const teardownSchema = z.strictObject({ generation: z.int().positive().optional() });

function approvedFixture(labId, fixtureId) {
  const lab = getLabManifest(labId);
  if (fixtureId !== lab.fixtureId && !lab.fixtureOptions?.includes(fixtureId)) {
    throw new DriverFailure('UNSUPPORTED_FIXTURE', 'The fixture is not approved for this lab.');
  }
  return getFixture(fixtureId);
}

function failureLine(error) {
  if (error instanceof DriverFailure) {
    return { kind: 'failure', code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error?.code === 'IMAGE_BUILD_FAILED' || error?.code === 'IMAGE_BUILD_TIMEOUT') {
    return { kind: 'failure', code: error.code, message: 'The approved fixture image could not be built.', retryable: true };
  }
  const classified = classifyDockerError(error);
  if (error?.statusCode === 409) {
    return { kind: 'failure', code: 'RESOURCE_CONFLICT', message: 'A Docker resource with this name already exists.', retryable: true };
  }
  return { kind: 'failure', ...classified };
}

/** Stream newline-delimited JSON records while the driver works. */
async function stream(req, res, work, state = {}) {
  res.status(200).type('application/x-ndjson').set('Cache-Control', 'no-store');
  let open = true;
  // The response closes when the controller disconnects (cancellation); the
  // request's own close event fires once its body is consumed and is not a disconnect.
  res.on('close', () => {
    open = false;
  });
  state.isOpen = () => open;
  const write = (record) => {
    if (open && !res.writableEnded) {
      res.write(`${JSON.stringify(record)}\n`);
    }
  };
  try {
    write({ kind: 'result', result: await work(write) });
  } catch (error) {
    write(failureLine(error));
  }
  res.end();
}

export function createSessionRouter({ driver, pipeline }) {
  const router = express.Router();

  function parse(schema, req, res) {
    if (!identifier.safeParse(req.params.sessionId).success) {
      res.status(400).json(errorBody('INVALID_SESSION', 'The session identifier is invalid.'));
      return null;
    }
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(errorBody('INVALID_REQUEST', 'The runner request is malformed.'));
      return null;
    }
    return parsed.data;
  }

  router.post('/:sessionId/setup', async (req, res) => {
    const body = parse(setupSchema, req, res);
    if (!body) {
      return;
    }
    await stream(req, res, async (write) => {
      approvedFixture(body.labId, body.fixtureId);
      const session = { id: req.params.sessionId, ...body };
      return driver.setup({ session, onLine: (line) => write({ kind: 'progress', line: line.slice(0, 500) }) });
    });
  });

  router.post('/:sessionId/execute', async (req, res) => {
    const body = parse(executeSchema, req, res);
    if (!body) {
      return;
    }
    const request = operationRequestSchema.safeParse({ type: body.operation.type, generation: body.generation, parameters: body.operation.parameters });
    if (!request.success || body.resources.some((resource) => resource.sessionId !== req.params.sessionId || resource.generation !== body.generation)) {
      res.status(400).json(errorBody('INVALID_OPERATION', 'The operation or its resources are invalid.'));
      return;
    }
    const state = {};
    await stream(req, res, async (write) => {
      approvedFixture(body.labId, body.fixtureId);
      const session = {
        id: req.params.sessionId, generation: body.generation, labId: body.labId, fixtureId: body.fixtureId,
        resources: body.resources, pipeline: body.pipeline ?? { knownGood: null, deployed: null, runs: [] },
      };
      const out = {
        emit: (type, payload, { source = 'docker' } = {}) => write({ kind: 'emit', type, payload, source }),
        logs: (lines) => {
          if (lines.length) {
            write({ kind: 'logs', lines });
          }
        },
      };
      const operation = { id: body.operation.id, ...request.data };
      if (operation.type === 'pipeline.run' || operation.type === 'pipeline.rollback') {
        if (!pipeline) {
          throw new DriverFailure('UNSUPPORTED_OPERATION', 'Pipelines are not available on this runner.');
        }
        return pipeline.execute({ session, operation, out, isCancelled: () => !state.isOpen() });
      }
      return driver.execute({ session, operation, out });
    }, state);
  });

  router.post('/:sessionId/teardown', async (req, res) => {
    const body = parse(teardownSchema, req, res);
    if (!body) {
      return;
    }
    await stream(req, res, () => driver.teardown({ sessionId: req.params.sessionId, generation: body.generation }));
  });

  return router;
}
