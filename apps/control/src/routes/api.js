import express from 'express';
import { availableLabs, getLabManifest, labCatalog } from '@devops-playground/lab-core';
import { ApiError, sendError } from '../errors.js';
import { csrfTokenFor, requireCsrf } from '../security.js';
import { streamSessionEvents } from '../sessions/sse.js';

const IDEMPOTENCY_KEY = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

function summarizeLab(lab) {
  return {
    id: lab.id,
    kind: lab.kind ?? 'mission',
    title: lab.title,
    description: lab.description,
    difficulty: lab.difficulty,
    estimatedMinutes: lab.estimatedMinutes,
    fixtureId: lab.fixtureId,
    fixtureOptions: lab.fixtureOptions ?? [lab.fixtureId],
  };
}

/** Management API. Demo-mode portals advertise that local execution is unavailable. */
export function createApiRouter({ config, store, runner, operations }) {
  const router = express.Router();
  const labsFor = () => (config.mode === 'local' ? availableLabs({ mode: 'local', operations }) : []);

  function requireLocal() {
    if (config.mode !== 'local') {
      throw new ApiError(503, 'LOCAL_MODE_UNAVAILABLE', 'This portal runs in Demo mode; local execution is unavailable.', {
        details: { mode: config.mode },
      });
    }
  }

  function ownedRuntime(req) {
    const runtime = store.get(req.params.id, req.browserSession);
    if (!runtime) {
      throw new ApiError(404, 'SESSION_NOT_FOUND', 'No session with this ID belongs to this browser.');
    }
    return runtime;
  }

  router.get('/security/csrf', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ token: csrfTokenFor(config.csrfSecret, req.browserSession) });
  });

  router.get('/capabilities', async (req, res) => {
    const base = { mode: config.mode, operations: config.mode === 'local' ? operations : [] };
    if (config.mode !== 'local') {
      res.json({ ...base, runner: { status: 'disabled' }, docker: null, labs: [] });
      return;
    }
    const [health, docker] = await Promise.all([runner.health(), runner.docker()]);
    res.json({
      ...base,
      runner: health.ok ? { status: 'connected' } : { status: 'unavailable', error: health.error },
      docker: health.ok ? (docker.body ?? { available: false, error: docker.error }) : null,
      labs: health.ok && docker.ok ? labsFor().map(summarizeLab) : [],
    });
  });

  router.get('/labs', (req, res) => {
    res.json({ labs: labsFor().map(summarizeLab), catalog: labCatalog.map((lab) => lab.id) });
  });

  router.post('/sessions', requireCsrf(config.csrfSecret), async (req, res) => {
    requireLocal();
    const { labId, fixtureId = null } = req.body ?? {};
    if (typeof labId !== 'string' || !SLUG.test(labId) || (fixtureId !== null && (typeof fixtureId !== 'string' || !SLUG.test(fixtureId)))) {
      throw new ApiError(400, 'INVALID_REQUEST', 'labId and optional fixtureId must be lab identifiers.');
    }
    let lab;
    try {
      lab = getLabManifest(labId);
    } catch {
      throw new ApiError(404, 'LAB_NOT_FOUND', 'The lab does not exist.');
    }
    if (!labsFor().some((item) => item.id === lab.id)) {
      throw new ApiError(422, 'LAB_UNAVAILABLE', 'The local backend cannot run this lab yet.');
    }
    // Never create a session on a backend that cannot observe real resources.
    const health = await runner.health();
    if (!health.ok) {
      throw new ApiError(503, health.error?.code ?? 'RUNNER_UNAVAILABLE', health.error?.message ?? 'The local runner is not reachable.', { retryable: true });
    }
    const docker = await runner.docker();
    if (!docker.ok) {
      const error = docker.body?.error ?? docker.error ?? {};
      throw new ApiError(503, error.code ?? 'DOCKER_UNAVAILABLE', error.message ?? 'The Docker daemon is unavailable.', { retryable: true });
    }
    const session = await store.create({ owner: req.browserSession, labId: lab.id, fixtureId });
    res.status(201).json({ session });
  });

  router.get('/sessions', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ sessions: config.mode === 'local' ? store.listOwned(req.browserSession) : [] });
  });

  router.get('/sessions/:id', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ session: ownedRuntime(req).getSession() });
  });

  router.post('/sessions/:id/operations', requireCsrf(config.csrfSecret), (req, res) => {
    const runtime = ownedRuntime(req);
    const key = req.get('idempotency-key');
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      sendError(res, 400, 'INVALID_IDEMPOTENCY_KEY', 'An Idempotency-Key header is required.');
      return;
    }
    const operation = runtime.submit(req.body ?? {}, { idempotencyKey: key });
    res.status(202).json({ operation });
  });

  router.get('/sessions/:id/operations/:operationId', (req, res) => {
    const operation = ownedRuntime(req).getOperation(req.params.operationId);
    if (!operation) {
      throw new ApiError(404, 'OPERATION_NOT_FOUND', 'No such operation in this session.');
    }
    res.set('Cache-Control', 'no-store').json({ operation });
  });

  router.get('/sessions/:id/events', (req, res) => {
    streamSessionEvents(req, res, ownedRuntime(req));
  });

  router.use((req, res) => sendError(res, 404, 'NOT_FOUND', 'Unknown API route.'));
  return router;
}
