import { describe, expect, it, vi } from 'vitest';
import { probeService } from '../src/docker/probe.js';
import { demultiplex, observationFrom, readContainerLogs } from '../src/docker/observe.js';
import { isOwned, ownershipFilter, resourceName } from '../src/docker/labels.js';
import { createLabDriver, DriverFailure } from '../src/docker/lab-driver.js';
import { buildArgsFor, fixtureDigest } from '../src/docker/images.js';

const response = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

describe('approved HTTP probes', () => {
  it('reports a successful JSON health response', async () => {
    const fetchImpl = vi.fn(async () => response(200, { status: 'ok', service: 'devops-playground' }));
    const result = await probeService({ serviceId: 'api', kind: 'health', port: 3000, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith('http://api:3000/health', expect.objectContaining({ redirect: 'manual' }));
    expect(result).toMatchObject({ ok: true, statusCode: 200, path: '/health', error: null });
  });

  it('never follows redirects', async () => {
    const fetchImpl = async () => response(302, '', { location: 'http://169.254.169.254/' });
    expect(await probeService({ serviceId: 'api', kind: 'version', port: 3000, fetchImpl }))
      .toMatchObject({ ok: false, statusCode: 302, error: 'Redirects are not followed by workbench probes.' });
  });

  it('bounds the response body at 16 KiB', async () => {
    const fetchImpl = async () => response(200, 'x'.repeat(17 * 1024));
    expect(await probeService({ serviceId: 'api', kind: 'health', port: 3000, fetchImpl }))
      .toMatchObject({ ok: false, error: 'Probe response exceeded 16 KiB.' });
  });

  it('reports refused connections and timeouts', async () => {
    const refused = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
    expect((await probeService({ serviceId: 'api', kind: 'health', port: 3000, fetchImpl: refused })).error).toBe('connect ECONNREFUSED api:3000');
    const timeout = async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); };
    expect((await probeService({ serviceId: 'api', kind: 'health', port: 3000, fetchImpl: timeout })).error).toMatch(/timed out after 5000 ms/);
  });

  it.each([
    { serviceId: 'evil.example.com', kind: 'health', port: 3000 },
    { serviceId: 'api', kind: 'health', port: 80 },
    { serviceId: 'api', kind: 'admin', port: 3000 },
  ])('refuses unapproved targets %j', async (target) => {
    await expect(probeService({ ...target, fetchImpl: vi.fn() })).rejects.toThrow('Probe target is not approved.');
  });
});

describe('Docker observations', () => {
  const info = (state) => ({ Config: { Image: 'devops-playground-lab/api:1.0.0' }, State: state });

  it('separates lifecycle and health and distinguishes requested stops from crashes', () => {
    expect(observationFrom(info({ Status: 'running', StartedAt: '2026-11-04T10:00:00.5Z', Health: { Status: 'unhealthy' } }), { appPort: 3001 }))
      .toMatchObject({ state: 'running', health: 'unhealthy', startedAt: '2026-11-04T10:00:00.500Z', ports: [{ containerPort: 3001, hostPort: null }] });
    expect(observationFrom(info({ Status: 'exited', ExitCode: 0, StartedAt: '2026-11-04T10:00:00Z' }), { appPort: 3000 }))
      .toMatchObject({ state: 'stopped', exitCode: 0 });
    expect(observationFrom(info({ Status: 'exited', ExitCode: 1, StartedAt: '2026-11-04T10:00:00Z' }), { appPort: 3000 }))
      .toMatchObject({ state: 'exited', exitCode: 1 });
    expect(observationFrom(info({ Status: 'created', StartedAt: '0001-01-01T00:00:00Z' }), { appPort: 3000 }))
      .toMatchObject({ state: 'created', startedAt: null, health: 'unknown' });
  });

  it('demultiplexes Docker log frames and reads only lines after the cursor', async () => {
    const frame = (stream, text) => {
      const header = Buffer.alloc(8);
      header[0] = stream;
      header.writeUInt32BE(Buffer.byteLength(text), 4);
      return Buffer.concat([header, Buffer.from(text)]);
    };
    const buffer = Buffer.concat([
      frame(1, '2026-11-04T10:00:00.100000000Z listening\n'),
      frame(2, '2026-11-04T10:00:00.200000000Z boom\n'),
    ]);
    expect(demultiplex(buffer).map((record) => record.stream)).toEqual(['stdout', 'stderr']);
    const container = { logs: async () => buffer };
    const first = await readContainerLogs(container, { serviceId: 'api' });
    expect(first.lines).toEqual([
      { serviceId: 'api', stream: 'stdout', level: 'info', message: 'listening', at: '2026-11-04T10:00:00.100Z' },
      { serviceId: 'api', stream: 'stderr', level: 'error', message: 'boom', at: '2026-11-04T10:00:00.200Z' },
    ]);
    expect((await readContainerLogs(container, { serviceId: 'api', cursor: first.cursor })).lines).toEqual([]);
  });
});

describe('ownership labels and fixture builds', () => {
  it('requires the managed flag, installation, session, and generation', () => {
    const labels = {
      'devops-playground.managed': 'true', 'devops-playground.installation': 'inst', 'devops-playground.session': 's1', 'devops-playground.generation': '2',
    };
    expect(isOwned(labels, { installationId: 'inst', sessionId: 's1', generation: 2 })).toBe(true);
    expect(isOwned(labels, { installationId: 'other', sessionId: 's1', generation: 2 })).toBe(false);
    expect(isOwned(labels, { installationId: 'inst', sessionId: 's1', generation: 1 })).toBe(false);
    expect(ownershipFilter({ installationId: 'inst', sessionId: 's1' }).label).toEqual([
      'devops-playground.managed=true', 'devops-playground.installation=inst', 'devops-playground.session=s1',
    ]);
    expect(resourceName('e3b997c7-7927-406a', 3, 'api')).toBe('dpg-e3b997c77927-g3-api');
  });

  it('derives build arguments only from the approved release', () => {
    expect(buildArgsFor({ version: '1.1.0', startup: 'crash' })).toEqual({ APP_VERSION: '1.1.0', STARTUP_MODE: 'require-feature-flags' });
    expect(fixtureDigest()).toMatch(/^[a-f0-9]{32}$/);
  });
});

describe('inventory, recovery, and metrics', () => {
  const owned = (extra = {}) => ({
    'devops-playground.managed': 'true', 'devops-playground.installation': 'inst', 'devops-playground.session': 's1',
    'devops-playground.generation': '2', 'devops-playground.lab': 'stopped-container', 'devops-playground.fixture': 'api-stopped', ...extra,
  });

  it('groups only this installation\'s resources by session', async () => {
    const docker = {
      listContainers: async () => [
        { Id: 'c1', Names: ['/dpg-s1-g2-api'], State: 'running', Image: 'devops-playground-lab/api:1.0.0', Labels: owned({ 'devops-playground.service': 'api', 'devops-playground.role': 'workload' }) },
        { Id: 'c2', Names: ['/foreign'], State: 'running', Image: 'x', Labels: { ...owned(), 'devops-playground.installation': 'other' } },
      ],
      listNetworks: async () => [{ Name: 'dpg-s1-g2', Labels: owned() }],
    };
    const driver = createLabDriver({ docker, installationId: 'inst' });
    expect(await driver.inventory()).toEqual([{
      sessionId: 's1', generation: 2, labId: 'stopped-container', fixtureId: 'api-stopped',
      containers: [{ name: 'dpg-s1-g2-api', serviceId: 'api', role: 'workload', state: 'running', image: 'devops-playground-lab/api:1.0.0' }],
      networks: ['dpg-s1-g2'],
    }]);
  });

  it('refuses recovery without complete ownership labels', async () => {
    const docker = {
      listContainers: async () => [{ Id: 'c1', Names: ['/x'], State: 'exited', Image: 'i', Labels: owned({ 'devops-playground.fixture': undefined }) }],
      listNetworks: async () => [],
    };
    const driver = createLabDriver({ docker, installationId: 'inst' });
    await expect(driver.recover({ sessionId: 's1' })).rejects.toEqual(expect.objectContaining({ code: 'RECOVERY_UNAVAILABLE' }));
  });

  it('computes CPU and memory from Docker statistics and reports stopped workloads as unavailable', async () => {
    const docker = {
      listContainers: async () => [
        { Id: 'c1', State: 'running', Labels: owned({ 'devops-playground.service': 'api', 'devops-playground.role': 'workload' }) },
        { Id: 'c2', State: 'exited', Labels: owned({ 'devops-playground.service': 'worker', 'devops-playground.role': 'workload' }) },
        { Id: 'c3', State: 'running', Labels: owned({ 'devops-playground.role': 'pipeline-test' }) },
      ],
      getContainer: () => ({
        stats: async () => ({
          cpu_stats: { cpu_usage: { total_usage: 2_000_000 }, system_cpu_usage: 200_000_000, online_cpus: 4 },
          precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 100_000_000 },
          memory_stats: { usage: 40 * 1024 * 1024, limit: 256 * 1024 * 1024, stats: { inactive_file: 8 * 1024 * 1024 } },
          pids_stats: { current: 7 },
        }),
      }),
    };
    const { samples } = await createLabDriver({ docker, installationId: 'inst' }).metrics({ sessionId: 's1', generation: 2 });
    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({ serviceId: 'api', available: true, cpuPercent: 4, memoryBytes: 32 * 1024 * 1024, memoryLimitBytes: 256 * 1024 * 1024, pids: 7, source: 'docker' });
    expect(samples[1]).toMatchObject({ serviceId: 'worker', available: false, reason: 'container is exited' });
  });
});

describe('lab driver cleanup', () => {
  it('removes partially created resources when fixture setup fails', async () => {
    const networkLabels = {
      'devops-playground.managed': 'true', 'devops-playground.installation': 'inst', 'devops-playground.session': 's1', 'devops-playground.generation': '1',
    };
    const removed = [];
    const docker = {
      getImage: () => ({ inspect: async () => ({ Id: 'img', Config: { Labels: { 'devops-playground.fixture-digest': fixtureDigest() } } }) }),
      createNetwork: async () => ({}),
      getNetwork: (id) => ({
        connect: async () => {},
        disconnect: async () => {},
        inspect: async () => ({ Name: 'dpg-s1-g1', Labels: networkLabels }),
        remove: async () => removed.push(id),
      }),
      createContainer: async () => { throw Object.assign(new Error('no space left on device'), { statusCode: 500 }); },
      listContainers: async () => [],
      listNetworks: async () => [{ Id: 'net-1', Name: 'dpg-s1-g1' }],
    };
    const driver = createLabDriver({ docker, installationId: 'inst', selfContainerId: 'runner' });
    await expect(driver.setup({ session: { id: 's1', generation: 1, labId: 'stopped-container', fixtureId: 'api-stopped' } }))
      .rejects.toThrow('no space left on device');
    expect(removed).toEqual(['net-1']);
  });

  it('rejects containers whose labels do not prove ownership', async () => {
    const docker = {
      listContainers: async () => [{ Id: 'c1' }],
      getContainer: () => ({ inspect: async () => ({ Config: { Labels: { 'devops-playground.managed': 'true', 'devops-playground.installation': 'someone-else' } } }) }),
    };
    const driver = createLabDriver({ docker, installationId: 'inst' });
    await expect(driver.ownedContainer({ sessionId: 's1', generation: 1, serviceId: 'api' }))
      .rejects.toEqual(expect.objectContaining({ code: 'OWNERSHIP_REJECTED' }));
    expect(new DriverFailure('X', 'y')).toBeInstanceOf(Error);
  });
});
