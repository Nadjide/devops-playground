import { createFixtureHistory, createFixtureResources } from '../fixtures/catalog.js';
import { getRelease, SERVICE_NAME, workloadLines } from '../fixtures/releases.js';
import { OperationFailure } from '../engine/errors.js';

/** Virtual durations in milliseconds. Tests advance a virtual clock past them. */
export const SIMULATED_TIMINGS = Object.freeze({
  startup: 600,
  stop: 400,
  healthcheck: 1200,
  probe: 80,
  inspect: 60,
  logs: 60,
});

export const SIMULATED_OPERATIONS = Object.freeze([
  'container.start', 'container.stop', 'container.restart', 'container.inspect', 'container.logs',
  'health.probe', 'version.probe', 'session.reset', 'session.end',
]);

function resourceFor(ctx, serviceId) {
  return ctx.session().resources.find((resource) => resource.serviceId === serviceId);
}

function lines(ctx, serviceId, entries) {
  const at = ctx.now();
  ctx.emitLogs(entries.map((entry) => ({ serviceId, at, ...entry })));
}

/**
 * Deterministic browser-side Docker model. Every effect is reported as an
 * observation through the runtime so all panels read one coherent snapshot.
 */
export function createSimulatorExecutor({ timings = SIMULATED_TIMINGS } = {}) {
  async function start(operation, ctx) {
    const { serviceId } = operation.parameters;
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

    if (release.startup === 'crash') {
      lines(ctx, serviceId, workloadLines.crash(release));
      ctx.emit('resource.observed', {
        resourceId: resource.id, state: 'exited', health: 'unhealthy', exitCode: 1, startedAt,
      });
      throw new OperationFailure('CONTAINER_EXITED', `${serviceId} exited with code 1 during startup.`);
    }

    lines(ctx, serviceId, workloadLines.startup(release, resource.desired.appPort));
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
    const { serviceId } = operation.parameters;
    const resource = resourceFor(ctx, serviceId);
    if (!['running', 'starting'].includes(resource.observed.state)) {
      return { serviceId, state: resource.observed.state, changed: false };
    }
    await ctx.delay(timings.stop);
    lines(ctx, serviceId, workloadLines.shutdown());
    ctx.emit('resource.observed', { resourceId: resource.id, state: 'stopped', health: 'unknown', exitCode: 0 });
    return { serviceId, state: 'stopped', exitCode: 0, changed: true };
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

  async function probe(kind, operation, ctx) {
    const { serviceId } = operation.parameters;
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
    if (!observation.ok) {
      throw new OperationFailure('PROBE_FAILED', `GET http://${serviceId}:${port}${path} failed: ${observation.error}`, {
        retryable: true,
      });
    }
    return observation;
  }

  const handlers = {
    'container.start': start,
    'container.stop': stop,
    async 'container.restart'(operation, ctx) {
      await stop(operation, ctx);
      return start(operation, ctx);
    },
    'container.inspect': inspect,
    'container.logs': logs,
    'health.probe': (operation, ctx) => probe('health', operation, ctx),
    'version.probe': (operation, ctx) => probe('version', operation, ctx),
  };

  return {
    backend: 'Browser simulator',
    supportedOperations: SIMULATED_OPERATIONS,
    async setup({ fixtureId, sessionId, generation, now }) {
      return {
        resources: createFixtureResources(fixtureId, { sessionId, generation, observedAt: now, source: 'simulator' }),
        logs: createFixtureHistory(fixtureId, { now }),
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
