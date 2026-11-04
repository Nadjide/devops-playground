import { withTimeout } from './diagnostics.js';
import { LABELS, ownershipLabels, resourceName } from './labels.js';
import { DriverFailure } from './errors.js';

/**
 * Pinned emulator images, verified in server mode with the operations the
 * storage missions use. Tags are informative; the digest is what is pulled.
 */
export const EMULATORS = Object.freeze({
  'aws-s3': Object.freeze({
    provider: 'aws-s3',
    label: 'Moto 5.2.5 (S3)',
    image: 'motoserver/moto:5.2.5@sha256:59a1965d845249b04def37a0e2565f9cc6c44543cb89b68e90f28f344b3b0d1a',
    port: 5000,
    user: '65534:65534',
    cmd: null,
  }),
  'azure-blob': Object.freeze({
    provider: 'azure-blob',
    label: 'Azurite 3.37.0 (Blob)',
    image: 'mcr.microsoft.com/azure-storage/azurite:3.37.0@sha256:830430c1da1a2d537e08f3e6764dd1f5ae00cf0346bcaf625b968ec3f0971fd5',
    port: 10000,
    user: '65534:65534',
    // Blob service only, in memory (read-only root filesystem), account name taken from the path.
    cmd: Object.freeze([
      'azurite-blob', '--blobHost', '0.0.0.0', '--blobPort', '10000', '--inMemoryPersistence', '--extentMemoryLimit', '64',
      '--disableTelemetry', '--disableProductStyleUrl',
    ]),
  }),
});

export const EMULATOR_LIMITS = Object.freeze({
  memoryBytes: 256 * 1024 * 1024,
  nanoCpus: 500_000_000,
  pids: 128,
  pullTimeoutMs: 5 * 60_000,
  readyTimeoutMs: 30_000,
});

/** The emulator is reachable on the session network as `storage`, like a managed endpoint. */
export const EMULATOR_ALIAS = 'storage';

export function emulatorFor(provider) {
  const emulator = EMULATORS[provider];
  if (!emulator) {
    throw new DriverFailure('PROVIDER_UNAVAILABLE', `The local runner has no emulator for ${provider} yet.`);
  }
  return emulator;
}

function followPull(docker, stream, onLine) {
  return new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve()), (event) => {
      if (event.status && !event.progressDetail?.current) {
        onLine?.(`${event.status}${event.id ? ` ${event.id}` : ''}`);
      }
    });
  });
}

/** Pull the pinned image only when a storage lab needs it; core labs never do. */
export async function ensureEmulatorImage(docker, emulator, { onLine } = {}) {
  try {
    await docker.getImage(emulator.image).inspect();
    return { pulled: false };
  } catch (error) {
    if (error?.statusCode !== 404) {
      throw error;
    }
  }
  onLine?.(`Pulling ${emulator.label} emulator image`);
  try {
    const stream = await docker.pull(emulator.image);
    await withTimeout(followPull(docker, stream, onLine), EMULATOR_LIMITS.pullTimeoutMs, 'EMULATOR_PULL_TIMEOUT');
  } catch {
    throw new DriverFailure('EMULATOR_PULL_FAILED',
      `The ${emulator.label} emulator image could not be pulled. Check access to its container registry, then retry.`, { retryable: true });
  }
  return { pulled: true };
}

/** A session-owned emulator: internal network only, no published port, constrained like workloads. */
export function createEmulatorContainer(docker, { installationId, session, emulator, network }) {
  return docker.createContainer({
    name: resourceName(session.id, session.generation, EMULATOR_ALIAS),
    Image: emulator.image,
    ...(emulator.cmd ? { Cmd: [...emulator.cmd] } : {}),
    Labels: {
      ...ownershipLabels({ installationId, sessionId: session.id, generation: session.generation, labId: session.labId, fixtureId: session.fixtureId }),
      [LABELS.service]: EMULATOR_ALIAS,
      [LABELS.role]: 'emulator',
    },
    User: emulator.user,
    ExposedPorts: { [`${emulator.port}/tcp`]: {} },
    HostConfig: {
      NetworkMode: network,
      Memory: EMULATOR_LIMITS.memoryBytes,
      NanoCpus: EMULATOR_LIMITS.nanoCpus,
      PidsLimit: EMULATOR_LIMITS.pids,
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=32m' },
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Privileged: false,
      PortBindings: {},
      LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
      RestartPolicy: { Name: 'no' },
    },
    NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [EMULATOR_ALIAS] } } },
  });
}

/** Wait until the emulator answers a real API call through the adapter. */
export async function waitForEmulator(adapter, { timeoutMs = EMULATOR_LIMITS.readyTimeoutMs, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      await adapter.ready();
      return;
    } catch (error) {
      last = error;
      await sleep(500);
    }
  }
  throw new DriverFailure('EMULATOR_NOT_READY', `The storage emulator did not answer within ${Math.round(timeoutMs / 1000)} s (${last?.code ?? 'no response'}).`, { retryable: true });
}
