import os from 'node:os';
import {
  createFixturePipeline, createFixtureResources, getFixture, getRelease,
} from '@devops-playground/lab-core';
import { ensureReleaseImage } from './images.js';
import { isOwned, LABELS, ownershipFilter, ownershipLabels, resourceName } from './labels.js';
import { observationFrom, readContainerLogs } from './observe.js';
import { probeService } from './probe.js';

export const WORKLOAD_LIMITS = Object.freeze({
  memoryBytes: 256 * 1024 * 1024,
  nanoCpus: 500_000_000,
  pids: 128,
  stopSeconds: 10,
  startObservationMs: 8000,
  logTail: 200,
});

export class DriverFailure extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Real Docker driver for one installation. Every mutation resolves resources
 * by ownership labels and re-verifies them on the inspected object first.
 * Workloads get a dedicated internal network, no socket, and no runner token.
 */
export function createLabDriver({ docker, installationId, selfContainerId = os.hostname(), probe = probeService }) {
  const logCursors = new Map();

  async function ownedContainer({ sessionId, generation, serviceId }) {
    const matches = await docker.listContainers({ all: true, filters: ownershipFilter({ installationId, sessionId, generation, serviceId }) });
    if (matches.length !== 1) {
      throw new DriverFailure('RESOURCE_NOT_FOUND', `No owned ${serviceId} container exists for this session generation.`);
    }
    const container = docker.getContainer(matches[0].Id);
    const info = await container.inspect();
    if (!isOwned(info.Config.Labels, { installationId, sessionId, generation }) || info.Config.Labels[LABELS.service] !== serviceId) {
      throw new DriverFailure('OWNERSHIP_REJECTED', 'The container is not owned by this session.');
    }
    return { container, info };
  }

  async function observe(container, appPort, { stoppedByRequest = true } = {}) {
    const info = await container.inspect();
    return observationFrom(info, { appPort, stoppedByRequest });
  }

  /**
   * New log lines since the last read. After a runner restart the in-memory
   * cursor is gone, so the controller's last ingested timestamp bounds the read.
   */
  async function newLogs(container, serviceId, fallbackAt = null) {
    const id = container.id;
    const known = logCursors.get(id) ?? null;
    const { lines, cursor } = await readContainerLogs(container, { serviceId, cursor: known, tail: WORKLOAD_LIMITS.logTail });
    if (cursor) {
      logCursors.set(id, cursor);
    }
    return known || !fallbackAt ? lines : lines.filter((line) => line.at > fallbackAt);
  }

  async function joinNetwork(networkName) {
    try {
      await docker.getNetwork(networkName).connect({ Container: selfContainerId });
    } catch (error) {
      // Already connected (409) or not running in a container (local tests): probes then cannot resolve.
      if (error?.statusCode !== 403 && error?.statusCode !== 409 && error?.statusCode !== 404) {
        throw error;
      }
    }
  }

  async function createWorkload({ session, service, image, appPort, network }) {
    const name = resourceName(session.id, session.generation, service.serviceId);
    return docker.createContainer({
      name,
      Image: image,
      Env: [`APP_PORT=${appPort}`],
      Labels: { ...ownershipLabels({ installationId, sessionId: session.id, generation: session.generation, labId: session.labId, fixtureId: session.fixtureId }), [LABELS.service]: service.serviceId, [LABELS.role]: 'workload' },
      User: 'node',
      StopTimeout: WORKLOAD_LIMITS.stopSeconds,
      HostConfig: {
        NetworkMode: network,
        Memory: WORKLOAD_LIMITS.memoryBytes,
        NanoCpus: WORKLOAD_LIMITS.nanoCpus,
        PidsLimit: WORKLOAD_LIMITS.pids,
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16m' },
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Privileged: false,
        LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
        RestartPolicy: { Name: 'no' },
      },
      NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [service.serviceId] } } },
    });
  }

  /** Start and watch long enough to see a crash instead of trusting the start call. */
  async function startAndObserve(container, appPort) {
    await container.start();
    const deadline = Date.now() + WORKLOAD_LIMITS.startObservationMs;
    let observed = await observe(container, appPort, { stoppedByRequest: false });
    while (Date.now() < deadline && observed.state === 'running' && observed.health === 'starting') {
      await sleep(250);
      observed = await observe(container, appPort, { stoppedByRequest: false });
    }
    return observed;
  }

  async function stopAndObserve(container, appPort) {
    const info = await container.inspect();
    if (info.State.Running) {
      await container.stop({ t: WORKLOAD_LIMITS.stopSeconds });
    }
    return observe(container, appPort, { stoppedByRequest: true });
  }

  /** Create the fixture; on any failure remove what was created before reporting it. */
  async function setup({ session, onLine }) {
    try {
      return await createFixture({ session, onLine });
    } catch (error) {
      const cleanup = await teardown({ sessionId: session.id, generation: session.generation }).catch(() => null);
      if (cleanup?.remaining?.length) {
        throw new DriverFailure('SETUP_CLEANUP_INCOMPLETE',
          `Fixture setup failed and these owned resources remain: ${cleanup.remaining.join(', ')}.`, { retryable: true });
      }
      throw error;
    }
  }

  async function createFixture({ session, onLine }) {
    const fixture = getFixture(session.fixtureId);
    const network = resourceName(session.id, session.generation);
    const now = new Date().toISOString();
    for (const service of fixture.services) {
      await ensureReleaseImage(docker, getRelease(service.image), { installationId, onLine });
    }
    await docker.createNetwork({
      Name: network,
      Driver: 'bridge',
      Internal: true,
      Labels: ownershipLabels({ installationId, sessionId: session.id, generation: session.generation, labId: session.labId, fixtureId: session.fixtureId }),
    });
    await joinNetwork(network);

    const resources = createFixtureResources(session.fixtureId, { sessionId: session.id, generation: session.generation, observedAt: now, source: 'docker' });
    const logs = [];
    for (const [index, service] of fixture.services.entries()) {
      const container = await createWorkload({ session, service, image: service.image, appPort: service.appPort, network });
      let observed = await observe(container, service.appPort);
      if (service.state === 'running') {
        observed = await startAndObserve(container, service.appPort);
      } else if (service.state === 'stopped') {
        // Seed real shutdown evidence: run the known-good process, then stop it.
        await startAndObserve(container, service.appPort);
        observed = await stopAndObserve(container, service.appPort);
      } else if (service.state === 'exited') {
        observed = await startAndObserve(container, service.appPort);
      }
      logs.push(...await newLogs(container, service.serviceId));
      resources[index] = { ...resources[index], observed: { ...observed, source: 'docker', observedAt: new Date().toISOString() } };
    }
    return { resources, logs, pipeline: createFixturePipeline(session.fixtureId, { now, source: null }) };
  }

  async function replaceWorkload(session, resource, { appPort = resource.desired.appPort, image = resource.desired.image }, out) {
    const { container, info } = await ownedContainer({ sessionId: session.id, generation: session.generation, serviceId: resource.serviceId });
    const wasRunning = info.State.Running;
    if (wasRunning) {
      out.emit('resource.observed', { resourceId: resource.id, ...await stopAndObserve(container, resource.desired.appPort) });
      out.logs(await newLogs(container, resource.serviceId, session.logCursors?.[resource.serviceId]));
    }
    await container.remove({ force: true });
    logCursors.delete(container.id);
    const network = resourceName(session.id, session.generation);
    const replacement = await createWorkload({ session, service: resource, image, appPort, network });
    out.emit('resource.configured', { resourceId: resource.id, appPort, image });
    out.logs([{ serviceId: resource.serviceId, stream: 'system', level: 'info', at: new Date().toISOString(),
      message: `Container ${resource.serviceId} recreated from ${image} with APP_PORT=${appPort}` }]);
    out.emit('resource.observed', { resourceId: resource.id, ...await observe(replacement, appPort) });
    return { replacement, wasRunning };
  }

  /** One probe of the fixed alias and expected port, recorded with probe provenance. */
  async function probeOnce({ session, resource, kind, out }) {
    const port = resource.desired.expectedProbePort;
    const { info } = await ownedContainer({ sessionId: session.id, generation: session.generation, serviceId: resource.serviceId });
    // A stopped container has no address on the session network; report the observed
    // state immediately instead of waiting for name resolution to time out.
    const result = info.State.Running
      ? await probe({ serviceId: resource.serviceId, kind, port })
      : {
        serviceId: resource.serviceId, kind, port, path: kind === 'health' ? '/health' : '/version',
        ok: false, statusCode: null, body: null, durationMs: 0,
        error: `service ${resource.serviceId} is not running (container ${info.State.Status}); nothing accepts connections on ${resource.serviceId}:${port}`,
      };
    out.emit('probe.completed', result, { source: 'probe' });
    return result;
  }

  /** Replace the workload with an approved image and start it; a crash is observed, not thrown. */
  async function deploy({ session, resource, image, out }) {
    const { replacement } = await replaceWorkload(session, resource, { image }, out);
    const observed = await startAndObserve(replacement, resource.desired.appPort);
    out.logs(await newLogs(replacement, resource.serviceId, session.logCursors?.[resource.serviceId]));
    out.emit('resource.observed', { resourceId: resource.id, ...observed });
    return { container: replacement, observed };
  }

  async function currentObservation({ session, resource }) {
    const { container } = await ownedContainer({ sessionId: session.id, generation: session.generation, serviceId: resource.serviceId });
    return { container, observed: await observe(container, resource.desired.appPort, { stoppedByRequest: false }) };
  }

  async function execute({ session, operation, out }) {
    const { type, parameters } = operation;
    const resource = parameters.serviceId ? session.resources.find((item) => item.serviceId === parameters.serviceId) : null;
    if (parameters.serviceId && !resource) {
      throw new DriverFailure('UNKNOWN_SERVICE', 'The service does not belong to this session.');
    }
    const locate = () => ownedContainer({ sessionId: session.id, generation: session.generation, serviceId: resource.serviceId });

    switch (type) {
      case 'container.start': {
        const { container, info } = await locate();
        if (info.State.Running) {
          return { serviceId: resource.serviceId, state: 'running', changed: false };
        }
        out.emit('resource.observed', { resourceId: resource.id, state: 'starting', health: 'unknown', exitCode: null });
        const observed = await startAndObserve(container, resource.desired.appPort);
        out.logs(await newLogs(container, resource.serviceId, session.logCursors?.[resource.serviceId]));
        out.emit('resource.observed', { resourceId: resource.id, ...observed });
        if (observed.state !== 'running') {
          throw new DriverFailure('CONTAINER_EXITED', `${resource.serviceId} exited with code ${observed.exitCode} during startup.`);
        }
        return { serviceId: resource.serviceId, state: 'running', changed: true, startedAt: observed.startedAt };
      }
      case 'container.stop': {
        const { container, info } = await locate();
        if (!info.State.Running) {
          return { serviceId: resource.serviceId, state: observationFrom(info, { appPort: resource.desired.appPort }).state, changed: false };
        }
        const observed = await stopAndObserve(container, resource.desired.appPort);
        out.logs(await newLogs(container, resource.serviceId, session.logCursors?.[resource.serviceId]));
        out.emit('resource.observed', { resourceId: resource.id, ...observed });
        return { serviceId: resource.serviceId, state: observed.state, exitCode: observed.exitCode, changed: true };
      }
      case 'container.restart': {
        const { container } = await locate();
        const stopped = await stopAndObserve(container, resource.desired.appPort);
        out.emit('resource.observed', { resourceId: resource.id, ...stopped });
        const observed = await startAndObserve(container, resource.desired.appPort);
        out.logs(await newLogs(container, resource.serviceId, session.logCursors?.[resource.serviceId]));
        out.emit('resource.observed', { resourceId: resource.id, ...observed });
        if (observed.state !== 'running') {
          throw new DriverFailure('CONTAINER_EXITED', `${resource.serviceId} exited with code ${observed.exitCode} during startup.`);
        }
        return { serviceId: resource.serviceId, state: 'running', changed: true };
      }
      case 'container.inspect': {
        const { container } = await locate();
        const observed = await observe(container, resource.desired.appPort);
        out.emit('resource.observed', { resourceId: resource.id, ...observed });
        return { serviceId: resource.serviceId, configuration: { ...resource.desired }, observed: { ...observed, source: 'docker' } };
      }
      case 'container.logs': {
        const { container } = await locate();
        const lines = await newLogs(container, resource.serviceId, session.logCursors?.[resource.serviceId]);
        out.logs(lines);
        return { serviceId: resource.serviceId, tail: parameters.tail, newLines: lines.length };
      }
      case 'service.configure': {
        if (resource.desired.appPort === parameters.appPort) {
          return { serviceId: resource.serviceId, appPort: parameters.appPort, changed: false, replaced: false };
        }
        const { replacement, wasRunning } = await replaceWorkload(session, resource, { appPort: parameters.appPort }, out);
        let state = 'created';
        if (wasRunning) {
          const observed = await startAndObserve(replacement, parameters.appPort);
          out.logs(await newLogs(replacement, resource.serviceId, session.logCursors?.[resource.serviceId]));
          out.emit('resource.observed', { resourceId: resource.id, ...observed });
          state = observed.state;
        }
        return { serviceId: resource.serviceId, appPort: parameters.appPort, changed: true, replaced: true, state };
      }
      case 'health.probe':
      case 'version.probe': {
        const result = await probeOnce({ session, resource, kind: type === 'health.probe' ? 'health' : 'version', out });
        if (!result.ok) {
          throw new DriverFailure('PROBE_FAILED', `GET http://${resource.serviceId}:${result.port}${result.path} failed: ${result.error}`, { retryable: true });
        }
        return result;
      }
      default:
        throw new DriverFailure('UNSUPPORTED_OPERATION', `${type} is not supported by the local runner.`);
    }
  }

  /** Remove only resources owned by this installation and session, in dependency order. */
  async function teardown({ sessionId, generation }) {
    const removed = [];
    const remaining = [];
    const filters = ownershipFilter({ installationId, sessionId, generation });
    for (const summary of await docker.listContainers({ all: true, filters })) {
      const container = docker.getContainer(summary.Id);
      try {
        const info = await container.inspect();
        if (!isOwned(info.Config.Labels, { installationId, sessionId })) {
          continue;
        }
        await container.remove({ force: true });
        logCursors.delete(summary.Id);
        removed.push(info.Name.replace(/^\//, ''));
      } catch (error) {
        if (error?.statusCode === 404) {
          continue;
        }
        remaining.push(summary.Names?.[0]?.replace(/^\//, '') ?? summary.Id.slice(0, 12));
      }
    }
    for (const summary of await docker.listNetworks({ filters })) {
      const network = docker.getNetwork(summary.Id);
      try {
        const info = await network.inspect();
        if (!isOwned(info.Labels, { installationId, sessionId })) {
          continue;
        }
        await network.disconnect({ Container: selfContainerId, Force: true }).catch(() => {});
        await network.remove();
        removed.push(info.Name);
      } catch (error) {
        if (error?.statusCode !== 404) {
          remaining.push(summary.Name);
        }
      }
    }
    return { removed, remaining };
  }

  /** Owned resources of this installation, grouped by session, for restart recovery. */
  async function inventory() {
    const filters = ownershipFilter({ installationId });
    const sessions = new Map();
    const entry = (labels) => {
      const id = labels[LABELS.session];
      if (!sessions.has(id)) {
        sessions.set(id, { sessionId: id, generation: 0, labId: labels[LABELS.lab] ?? null, fixtureId: labels[LABELS.fixture] ?? null, containers: [], networks: [] });
      }
      return sessions.get(id);
    };
    for (const summary of await docker.listContainers({ all: true, filters })) {
      if (!isOwned(summary.Labels, { installationId }) || !summary.Labels[LABELS.session]) {
        continue;
      }
      const item = entry(summary.Labels);
      item.generation = Math.max(item.generation, Number(summary.Labels[LABELS.generation]) || 0);
      item.fixtureId ??= summary.Labels[LABELS.fixture] ?? null;
      item.containers.push({
        name: summary.Names?.[0]?.replace(/^\//, '') ?? summary.Id.slice(0, 12),
        serviceId: summary.Labels[LABELS.service] ?? null,
        role: summary.Labels[LABELS.role] ?? null,
        state: summary.State,
        image: summary.Image,
      });
    }
    for (const summary of await docker.listNetworks({ filters })) {
      if (isOwned(summary.Labels, { installationId }) && summary.Labels?.[LABELS.session]) {
        entry(summary.Labels).networks.push(summary.Name);
      }
    }
    return [...sessions.values()];
  }

  /**
   * Re-observe an owned session after a controller restart. Ownership comes from
   * verified labels; desired configuration is read back from the containers.
   */
  async function recover({ sessionId }) {
    const found = (await inventory()).find((item) => item.sessionId === sessionId);
    if (!found || !found.labId || !found.fixtureId || found.generation < 1) {
      throw new DriverFailure('RECOVERY_UNAVAILABLE', 'No recoverable resources with complete ownership labels exist for this session.');
    }
    const fixture = getFixture(found.fixtureId);
    const session = { id: sessionId, generation: found.generation, labId: found.labId, fixtureId: found.fixtureId };
    await joinNetwork(resourceName(sessionId, found.generation));
    const now = new Date().toISOString();
    const resources = [];
    const logs = [];
    for (const service of fixture.services) {
      const { container, info } = await ownedContainer({ sessionId, generation: found.generation, serviceId: service.serviceId });
      const env = Object.fromEntries((info.Config.Env ?? []).map((item) => [item.slice(0, item.indexOf('=')), item.slice(item.indexOf('=') + 1)]));
      const appPort = Number(env.APP_PORT ?? service.appPort);
      getRelease(info.Config.Image);
      const observed = observationFrom(info, { appPort, stoppedByRequest: true });
      resources.push({
        id: `${service.serviceId}-g${found.generation}`,
        sessionId,
        generation: found.generation,
        serviceId: service.serviceId,
        kind: 'container',
        desired: { image: info.Config.Image, appPort, expectedProbePort: service.expectedProbePort },
        observed: { ...observed, source: 'docker', observedAt: now },
      });
      logs.push(...(await newLogs(container, service.serviceId)).slice(-50));
    }
    return { session, resources, logs };
  }

  /** Bounded CPU and memory samples; unavailable measurements are reported, not invented. */
  async function metrics({ sessionId, generation }) {
    const samples = [];
    for (const summary of await docker.listContainers({ all: true, filters: ownershipFilter({ installationId, sessionId, generation }) })) {
      if (summary.Labels[LABELS.role] !== 'workload') {
        continue;
      }
      const serviceId = summary.Labels[LABELS.service];
      const observedAt = new Date().toISOString();
      if (summary.State !== 'running') {
        samples.push({ serviceId, available: false, reason: `container is ${summary.State}`, observedAt, source: 'docker' });
        continue;
      }
      try {
        const stats = await docker.getContainer(summary.Id).stats({ stream: false });
        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats.cpu_usage?.total_usage ?? 0);
        const systemDelta = (stats.cpu_stats.system_cpu_usage ?? 0) - (stats.precpu_stats.system_cpu_usage ?? 0);
        const cpus = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
        const cache = stats.memory_stats.stats?.inactive_file ?? stats.memory_stats.stats?.cache ?? 0;
        samples.push({
          serviceId,
          available: true,
          cpuPercent: systemDelta > 0 && cpuDelta >= 0 ? Math.round((cpuDelta / systemDelta) * cpus * 10000) / 100 : 0,
          memoryBytes: Math.max(0, (stats.memory_stats.usage ?? 0) - cache),
          memoryLimitBytes: stats.memory_stats.limit ?? null,
          pids: stats.pids_stats?.current ?? null,
          observedAt,
          source: 'docker',
        });
      } catch {
        samples.push({ serviceId, available: false, reason: 'Docker did not return statistics.', observedAt, source: 'docker' });
      }
    }
    return { samples };
  }

  return { setup, execute, teardown, ownedContainer, probeOnce, deploy, currentObservation, newLogs, inventory, recover, metrics };
}
