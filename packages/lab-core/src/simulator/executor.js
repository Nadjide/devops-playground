import {
  createFixtureHistory, createFixturePipeline, createFixtureResources, createFixtureStorage, getFixture,
} from '../fixtures/catalog.js';
import { storageTargetLine } from '../storage/validate.js';
import { createStorageHandlers } from './storage.js';
import { getRelease, getReleaseById, releaseRef, SERVICE_NAME, workloadLines } from '../fixtures/releases.js';
import { AbortedError, OperationFailure } from '../engine/errors.js';
import { createPipelineRecorder, createRunRecord } from '../pipeline/recorder.js';

/** Virtual durations in milliseconds. Tests advance a virtual clock past them. */
export const SIMULATED_TIMINGS = Object.freeze({
  startup: 600,
  stop: 400,
  healthcheck: 1200,
  probe: 80,
  inspect: 60,
  logs: 60,
  validate: 300,
  test: 1200,
  build: 1500,
  verifyInterval: 1000,
  verifyAttempts: 4,
  storage: 150,
});

export const SIMULATED_OPERATIONS = Object.freeze([
  'container.start', 'container.stop', 'container.restart', 'container.inspect', 'container.logs',
  'service.configure', 'health.probe', 'version.probe',
  'pipeline.run', 'pipeline.rollback', 'pipeline.cancel',
  'storage.namespace.create', 'storage.namespace.list', 'storage.namespace.delete',
  'storage.object.put', 'storage.object.list', 'storage.object.get', 'storage.object.delete',
  'storage.configure', 'storage.roundtrip.verify',
  'session.reset', 'session.end',
]);

function resourceFor(ctx, serviceId) {
  return ctx.session().resources.find((resource) => resource.serviceId === serviceId);
}

function storageLine(ctx, resource) {
  const { storage } = ctx.session();
  return storage && resource.desired.storage ? storageTargetLine(storage, resource.desired.storage) : null;
}

function lines(ctx, serviceId, entries) {
  const at = ctx.now();
  ctx.emitLogs(entries.map((entry) => ({ serviceId, at, ...entry })));
}

/**
 * Deterministic browser-side Docker and pipeline model. Every effect is
 * reported as an observation through the runtime so all panels read one
 * coherent snapshot. `faults` lets tests make an approved release crash.
 */
export function createSimulatorExecutor({ timings = SIMULATED_TIMINGS, faults = {} } = {}) {
  const startupOf = (release) => faults[release.id] ?? release.startup;

  async function start(operation, ctx, { tolerateCrash = false } = {}) {
    const { serviceId } = operation.parameters.serviceId ? operation.parameters : { serviceId: 'api' };
    const resource = resourceFor(ctx, serviceId);
    if (['running', 'starting'].includes(resource.observed.state)) {
      return { serviceId, state: resource.observed.state, changed: false };
    }
    const release = getRelease(resource.desired.image);
    ctx.emit('resource.observed', {
      resourceId: resource.id, state: 'starting', health: 'unknown', exitCode: null,
      image: resource.desired.image, ports: [{ containerPort: resource.desired.appPort, hostPort: null }],
    });
    await ctx.delay(timings.startup);
    const startedAt = ctx.now();

    if (startupOf(release) === 'crash') {
      lines(ctx, serviceId, workloadLines.crash(release));
      ctx.emit('resource.observed', {
        resourceId: resource.id, state: 'exited', health: 'unhealthy', exitCode: 1, startedAt,
      });
      if (tolerateCrash) {
        return { serviceId, state: 'exited', exitCode: 1, changed: true };
      }
      throw new OperationFailure('CONTAINER_EXITED', `${serviceId} exited with code 1 during startup.`);
    }

    lines(ctx, serviceId, workloadLines.startup(release, resource.desired.appPort, storageLine(ctx, resource)));
    ctx.emit('resource.observed', { resourceId: resource.id, state: 'running', health: 'starting', startedAt });
    ctx.later(timings.healthcheck, ({ session, emit }) => {
      const current = session().resources.find((item) => item.id === resource.id);
      if (current?.observed.state !== 'running' || current.observed.startedAt !== startedAt) {
        return;
      }
      // The image healthcheck targets the expected port inside the container.
      const healthy = current.desired.appPort === current.desired.expectedProbePort;
      emit('resource.observed', { resourceId: resource.id, state: 'running', health: healthy ? 'healthy' : 'unhealthy' });
    });
    return { serviceId, state: 'running', changed: true, startedAt };
  }

  async function stop(operation, ctx) {
    const serviceId = operation.parameters.serviceId ?? 'api';
    const resource = resourceFor(ctx, serviceId);
    if (!['running', 'starting'].includes(resource.observed.state)) {
      return { serviceId, state: resource.observed.state, changed: false };
    }
    await ctx.delay(timings.stop);
    lines(ctx, serviceId, workloadLines.shutdown());
    ctx.emit('resource.observed', { resourceId: resource.id, state: 'stopped', health: 'unknown', exitCode: 0 });
    return { serviceId, state: 'stopped', exitCode: 0, changed: true };
  }

  /** Replace a container with a new approved configuration, keeping its lifecycle intent. */
  async function replace(ctx, resource, change, { startAfter, tolerateCrash = false }) {
    const operation = { parameters: { serviceId: resource.serviceId } };
    await stop(operation, ctx);
    ctx.emit('resource.configured', { resourceId: resource.id, ...change });
    const updated = resourceFor(ctx, resource.serviceId);
    lines(ctx, resource.serviceId, [{
      stream: 'system', level: 'info',
      message: `Container ${resource.serviceId} recreated from ${updated.desired.image} with APP_PORT=${updated.desired.appPort}${updated.desired.storage ? ` STORAGE_NAMESPACE=${updated.desired.storage.namespace} STORAGE_ENDPOINT=${updated.desired.storage.endpoint}` : ''}`,
    }]);
    ctx.emit('resource.observed', {
      resourceId: resource.id, state: 'created', health: 'unknown', exitCode: null, startedAt: null,
      image: updated.desired.image, ports: [{ containerPort: updated.desired.appPort, hostPort: null }],
    });
    if (startAfter) {
      await start(operation, ctx, { tolerateCrash });
    }
    return resourceFor(ctx, resource.serviceId);
  }

  /** Apply an approved appPort; a running workload is replaced to pick it up. */
  async function configure(operation, ctx) {
    const { serviceId, appPort } = operation.parameters;
    const resource = resourceFor(ctx, serviceId);
    if (resource.desired.appPort === appPort) {
      return { serviceId, appPort, changed: false, replaced: false };
    }
    const wasRunning = ['running', 'starting'].includes(resource.observed.state);
    const updated = await replace(ctx, resource, { appPort }, { startAfter: wasRunning });
    return { serviceId, appPort, changed: true, replaced: true, state: updated.observed.state };
  }

  async function inspect(operation, ctx) {
    await ctx.delay(timings.inspect);
    const resource = resourceFor(ctx, operation.parameters.serviceId);
    return {
      serviceId: resource.serviceId,
      configuration: { ...resource.desired },
      observed: { ...resource.observed },
    };
  }

  async function logs(operation, ctx) {
    await ctx.delay(timings.logs);
    const { serviceId, tail } = operation.parameters;
    const { entries, dropped } = ctx.session().logs;
    const selected = entries.filter((entry) => entry.serviceId === serviceId).slice(-tail);
    return {
      serviceId,
      tail,
      count: selected.length,
      firstSeq: selected[0]?.seq ?? null,
      lastSeq: selected.at(-1)?.seq ?? null,
      truncated: dropped > 0,
    };
  }

  /** One HTTP probe against the fixed service alias and expected port. */
  async function probeOnce(kind, serviceId, ctx) {
    await ctx.delay(timings.probe);
    const resource = resourceFor(ctx, serviceId);
    const port = resource.desired.expectedProbePort;
    const path = kind === 'health' ? '/health' : '/version';
    const listening = resource.observed.state === 'running' && resource.desired.appPort === port;
    let observation = {
      serviceId, kind, port, path, ok: false, statusCode: null, body: null,
      error: `connect ECONNREFUSED ${serviceId}:${port}`, durationMs: timings.probe,
    };
    if (listening) {
      const release = getRelease(resource.desired.image);
      const uptime = Math.max(0, (Date.parse(ctx.now()) - Date.parse(resource.observed.startedAt)) / 1000);
      const body = kind === 'health'
        ? { status: 'ok', service: SERVICE_NAME, uptime: Math.round(uptime * 1000) / 1000, timestamp: ctx.now() }
        : { name: SERVICE_NAME, version: release.version, environment: 'production' };
      observation = { ...observation, ok: true, statusCode: 200, body, error: null };
    }
    ctx.emit('probe.completed', observation);
    return observation;
  }

  async function probe(kind, operation, ctx) {
    const { serviceId } = operation.parameters;
    const observation = await probeOnce(kind, serviceId, ctx);
    if (!observation.ok) {
      throw new OperationFailure('PROBE_FAILED', `GET http://${serviceId}:${observation.port}${observation.path} failed: ${observation.error}`, {
        retryable: true,
      });
    }
    return observation;
  }

  async function runStage(recorder, runId, stageId, ctx, work) {
    recorder.stageStart(runId, stageId);
    const outcome = await work();
    recorder.stageFinish(runId, stageId, outcome);
    if (outcome.status === 'failed') {
      throw new OperationFailure('PIPELINE_STAGE_FAILED', `${stageId}: ${outcome.reason}`);
    }
  }

  async function verifyRelease(ctx, release) {
    const log = [];
    let lastError = 'no probe attempted';
    for (let attempt = 1; attempt <= timings.verifyAttempts; attempt += 1) {
      await ctx.delay(timings.verifyInterval);
      const health = await probeOnce('health', 'api', ctx);
      if (!health.ok) {
        lastError = health.error;
        log.push(`Attempt ${attempt}: GET http://api:${health.port}/health failed: ${health.error}`);
        continue;
      }
      log.push(`Attempt ${attempt}: GET http://api:${health.port}/health returned 200`);
      const version = await probeOnce('version', 'api', ctx);
      if (version.ok && version.body.version === release.version) {
        log.push(`GET /version returned ${version.body.version} as expected`);
        return { status: 'passed', exitCode: 0, logs: log };
      }
      const observed = version.ok ? version.body.version : version.error;
      log.push(`GET /version returned ${observed}; expected ${release.version}`);
      return { status: 'failed', exitCode: 1, logs: log, reason: `version mismatch: expected ${release.version}, observed ${observed}.` };
    }
    const resource = resourceFor(ctx, 'api');
    const exited = resource.observed.state === 'exited' ? ` Container api exited with code ${resource.observed.exitCode}.` : '';
    log.push(`Verification deadline reached after ${timings.verifyAttempts} attempts.${exited}`.trim());
    return {
      status: 'failed', exitCode: 1, logs: log,
      reason: `GET /health did not succeed within ${timings.verifyAttempts} attempts (${lastError}).${exited}`,
    };
  }

  /** Fixed graph validate -> test -> build -> deploy -> verify, simulated deterministically. */
  async function executeRun(operation, ctx, kind, release) {
    const recorder = createPipelineRecorder(ctx, { source: 'simulator' });
    const runId = operation.id;
    recorder.start(createRunRecord({ id: runId, kind, release, startedAt: ctx.now() }));
    try {
      const api = resourceFor(ctx, 'api');
      await runStage(recorder, runId, 'validate', ctx, async () => {
        await ctx.delay(timings.validate);
        return {
          status: 'passed', exitCode: 0,
          logs: [
            `Release ${release.id} (${release.image}) is approved for this lab.`,
            `Service configuration: appPort ${api.desired.appPort}, expected probe port ${api.desired.expectedProbePort}.`,
          ],
        };
      });
      if (kind === 'rollback') {
        recorder.skip(runId, 'test', 'Reusing the verified known-good image; tests are not re-run.');
        recorder.skip(runId, 'build', `Reusing the existing image ${release.image}.`);
      } else {
        await runStage(recorder, runId, 'test', ctx, async () => {
          await ctx.delay(timings.test);
          return {
            status: 'passed', exitCode: 0,
            logs: ['$ npm ci --workspaces=false', '$ npm test', 'PASS tests/app.test.js', 'Tests: 3 passed, 3 total'],
          };
        });
        await runStage(recorder, runId, 'build', ctx, async () => {
          await ctx.delay(timings.build);
          return {
            status: 'passed', exitCode: 0,
            logs: [`$ docker build -t ${release.image} labs/fixtures/api`, 'Step 1/6 : FROM node:22-alpine', `Successfully tagged ${release.image}`],
          };
        });
      }
      await runStage(recorder, runId, 'deploy', ctx, async () => {
        const previous = ctx.session().pipeline.deployed;
        if (previous?.status === 'verified') {
          // Capture the observed known-good release before replacing it.
          recorder.setReleases(() => ({ knownGood: { releaseId: previous.releaseId, image: previous.image, version: previous.version } }));
        }
        const before = resourceFor(ctx, 'api').desired.image;
        await replace(ctx, resourceFor(ctx, 'api'), { image: release.image }, { startAfter: true, tolerateCrash: true });
        recorder.setReleases(() => ({ deployed: { ...releaseRef(release), status: 'unverified' } }));
        return { status: 'passed', exitCode: 0, logs: [`Replaced ${before} with ${release.image}`, `Container api started from ${release.image}`] };
      });
      let verification;
      await runStage(recorder, runId, 'verify', ctx, async () => {
        verification = await verifyRelease(ctx, release);
        return verification;
      }).catch((error) => {
        recorder.setReleases(() => ({ deployed: { ...releaseRef(release), status: 'failed' } }));
        throw error;
      });
      recorder.setReleases(() => ({ deployed: { ...releaseRef(release), status: 'verified' }, knownGood: releaseRef(release) }));
      recorder.finish(runId, { status: 'passed' });
      return { runId, kind, release: releaseRef(release), status: 'passed' };
    } catch (error) {
      if (error instanceof AbortedError || ctx.signal.aborted) {
        recorder.finish(runId, { status: 'cancelled', failureReason: null }, ctx.reconcile);
        throw new AbortedError();
      }
      const reason = error instanceof OperationFailure ? error.message : 'The pipeline failed unexpectedly.';
      recorder.finish(runId, { status: 'failed', failureReason: reason });
      throw error;
    }
  }

  async function pipelineRun(operation, ctx) {
    const fixture = getFixture(ctx.session().fixtureId);
    const { releaseId } = operation.parameters;
    if (!fixture.candidates.includes(releaseId)) {
      throw new OperationFailure('RELEASE_NOT_APPROVED', `Release ${releaseId} is not an approved candidate for this lab.`);
    }
    return executeRun(operation, ctx, 'deploy', getReleaseById(releaseId));
  }

  async function pipelineRollback(operation, ctx) {
    const { knownGood, deployed } = ctx.session().pipeline;
    if (!knownGood) {
      throw new OperationFailure('NO_KNOWN_GOOD_RELEASE', 'No known-good release has been recorded yet.');
    }
    if (deployed?.releaseId === knownGood.releaseId && deployed.status === 'verified') {
      throw new OperationFailure('ALREADY_ON_KNOWN_GOOD', `Release ${knownGood.version} is already deployed and verified.`);
    }
    return executeRun(operation, ctx, 'rollback', getReleaseById(knownGood.releaseId));
  }

  const handlers = {
    ...createStorageHandlers({ timings, replace }),
    'container.start': start,
    'container.stop': stop,
    async 'container.restart'(operation, ctx) {
      await stop(operation, ctx);
      return start(operation, ctx);
    },
    'container.inspect': inspect,
    'service.configure': configure,
    'container.logs': logs,
    'health.probe': (operation, ctx) => probe('health', operation, ctx),
    'version.probe': (operation, ctx) => probe('version', operation, ctx),
    'pipeline.run': pipelineRun,
    'pipeline.rollback': pipelineRollback,
  };

  return {
    backend: 'Browser simulator',
    supportedOperations: SIMULATED_OPERATIONS,
    async setup({ fixtureId, sessionId, generation, now }) {
      return {
        resources: createFixtureResources(fixtureId, { sessionId, generation, observedAt: now, source: 'simulator' }),
        logs: createFixtureHistory(fixtureId, { now }),
        pipeline: createFixturePipeline(fixtureId, { now }),
        storage: await createFixtureStorage(fixtureId, { now, source: 'simulator', withContent: true }),
      };
    },
    async teardown({ session }) {
      return { removed: session.resources.map((resource) => resource.serviceId), remaining: [] };
    },
    execute(operation, ctx) {
      const handler = handlers[operation.type];
      if (!handler) {
        throw new OperationFailure('UNSUPPORTED_OPERATION', `${operation.type} is not simulated.`);
      }
      return handler(operation, ctx);
    },
  };
}
