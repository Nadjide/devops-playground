import {
  API_IMAGE, getRelease, getReleaseById, releaseRef, STORAGE_API_IMAGE, workloadLines,
} from './releases.js';
import { getStorageProvider, sha256Hex, STORAGE_CHECK_KEY } from '../storage/providers.js';
import { utf8Bytes } from '../schemas/storage.js';
import { STAGE_IDS } from '../schemas/pipeline.js';

const KNOWN_GOOD = `${API_IMAGE}:1.0.0`;
const DEFAULT_CANDIDATES = Object.freeze(['api-1-0-1', 'api-1-1-0']);
const STORAGE_API = `${STORAGE_API_IMAGE}:1.0.0`;

/** A bucket another team owns: listable and readable, never changed by the lab. */
const FOREIGN_NAMESPACE = 'shared-audit-logs';
const FOREIGN_OBJECT = {
  namespace: FOREIGN_NAMESPACE,
  key: 'retention-policy.txt',
  content: 'Audit logs are retained for 90 days.\nOwner: platform team. Do not modify from lab sessions.\n',
};

function storageHistory({ provider, namespace, error }) {
  const profile = getStorageProvider(provider);
  return ({ release, service }) => {
    const target = { provider, term: profile.namespaceTerm, namespace, endpoint: service.storage.endpoint };
    const uri = profile.uri(namespace, STORAGE_CHECK_KEY);
    return [
      ...workloadLines.startup(release, service.appPort, target).map((line) => ({ ...line, offset: -240 })),
      ...workloadLines.storageCheck({ ok: false, uri, error }).map((line) => ({ ...line, offset: -180 })),
      ...workloadLines.storageCheck({ ok: false, uri, error }).map((line) => ({ ...line, offset: -60 })),
    ];
  };
}

const verifiedBaseline = () => ({
  knownGood: releaseRef(getReleaseById('api-1-0-0')),
  deployed: { ...releaseRef(getReleaseById('api-1-0-0')), status: 'verified' },
  runs: [],
});

/** A recorded deployment of 1.1.0: tests and build passed, runtime verification failed. */
function failedCandidateRun(base, source) {
  const at = (offset) => new Date(base + offset * 1000).toISOString();
  const stage = (id, start, end, status, logs, exitCode = 0) => ({
    id, status, startedAt: at(start), finishedAt: at(end), durationMs: (end - start) * 1000, exitCode, logs, source,
  });
  const candidate = getReleaseById('api-1-1-0');
  return {
    id: 'run-previous-1-1-0',
    kind: 'deploy',
    release: releaseRef(candidate),
    status: 'failed',
    stages: [
      stage('validate', -420, -419, 'passed', ['Release api-1-1-0 is approved for this lab.']),
      stage('test', -419, -405, 'passed', ['$ npm test', 'Tests: 3 passed, 3 total']),
      stage('build', -405, -400, 'passed', [`$ docker build -t ${candidate.image} labs/fixtures/api`, `Successfully tagged ${candidate.image}`]),
      stage('deploy', -400, -398, 'passed', [`Replaced ${KNOWN_GOOD} with ${candidate.image}`]),
      stage('verify', -398, -390, 'failed', [
        'Attempt 1: GET http://api:3000/health failed: connect ECONNREFUSED api:3000',
        'Attempt 4: GET http://api:3000/health failed: connect ECONNREFUSED api:3000',
        'Container api exited with code 1.',
      ], 1),
    ].map((item, index) => ({ ...item, id: STAGE_IDS[index] })),
    startedAt: at(-420),
    finishedAt: at(-390),
    failureReason: 'verify: GET /health did not succeed within 4 attempts; container api exited with code 1.',
  };
}

/**
 * Approved starting states. `history` lists log lines from before the session
 * started, with offsets in seconds relative to session creation.
 * `expectedVersion` is the release the version objective must observe and
 * `candidates` the releases the pipeline may deploy.
 */
const fixtures = {
  'api-running': {
    id: 'api-running',
    label: 'Known-good API, running',
    expectedVersion: '1.0.0',
    candidates: DEFAULT_CANDIDATES,
    services: [{ serviceId: 'api', image: KNOWN_GOOD, appPort: 3000, expectedProbePort: 3000, state: 'running', exitCode: null }],
    history: ({ release }) => workloadLines.startup(release, 3000).map((line) => ({ ...line, offset: -60 })),
    pipeline: verifiedBaseline,
  },
  'api-stopped': {
    id: 'api-stopped',
    label: 'Known-good API, stopped',
    expectedVersion: '1.0.0',
    candidates: DEFAULT_CANDIDATES,
    services: [{ serviceId: 'api', image: KNOWN_GOOD, appPort: 3000, expectedProbePort: 3000, state: 'stopped', exitCode: 0 }],
    history: ({ release }) => [
      ...workloadLines.startup(release, 3000).map((line) => ({ ...line, offset: -900 })),
      ...workloadLines.shutdown().map((line) => ({ ...line, offset: -120 })),
    ],
    pipeline: verifiedBaseline,
  },
  'api-wrong-port': {
    id: 'api-wrong-port',
    label: 'API listening on the wrong port',
    expectedVersion: '1.0.0',
    candidates: DEFAULT_CANDIDATES,
    services: [{ serviceId: 'api', image: KNOWN_GOOD, appPort: 3001, expectedProbePort: 3000, state: 'running', exitCode: null }],
    history: ({ release }) => workloadLines.startup(release, 3001).map((line) => ({ ...line, offset: -300 })),
    pipeline: verifiedBaseline,
  },
  'api-broken-release': {
    id: 'api-broken-release',
    label: 'Release 1.1.0 failing at startup',
    expectedVersion: '1.0.0',
    candidates: Object.freeze(['api-1-1-0']),
    services: [{
      serviceId: 'api', image: `${API_IMAGE}:1.1.0`, appPort: 3000, expectedProbePort: 3000,
      state: 'exited', exitCode: 1, health: 'unhealthy',
    }],
    history: ({ release }) => [
      ...workloadLines.startup(getReleaseById('api-1-0-0'), 3000).map((line) => ({ ...line, offset: -1800 })),
      ...workloadLines.shutdown().map((line) => ({ ...line, offset: -400 })),
      ...workloadLines.crash(release).map((line) => ({ ...line, offset: -397 })),
    ],
    pipeline: ({ base, source }) => ({
      knownGood: releaseRef(getReleaseById('api-1-0-0')),
      deployed: { ...releaseRef(getReleaseById('api-1-1-0')), status: 'failed' },
      runs: [failedCandidateRun(base, source)],
    }),
  },
  ...storageFixtures('aws-s3', { prefix: 's3', label: 'S3 bucket' }),
  ...storageFixtures('azure-blob', { prefix: 'blob', label: 'Blob container' }),
};

/**
 * The same two incidents for each provider, so both learning paths reach the
 * same outcome in their own terminology: a missing namespace (M04) and a
 * service configured for a misspelled one (M05).
 */
function storageFixtures(provider, { prefix, label }) {
  const profile = getStorageProvider(provider);
  const base = (id, fixtureLabel, configured, seed) => ({
    id,
    label: fixtureLabel,
    expectedVersion: '1.0.0',
    expectedNamespace: 'lab-reports',
    candidates: Object.freeze([]),
    services: [{
      serviceId: 'api', image: STORAGE_API, appPort: 3000, expectedProbePort: 3000, state: 'running', exitCode: null,
      storage: { namespace: configured, endpoint: profile.endpoint },
    }],
    storage: { provider, ...seed },
    history: storageHistory({ provider, namespace: configured, error: profile.errors.namespaceMissing(configured).message }),
    // Storage labs have no delivery pipeline.
    pipeline: () => ({ knownGood: null, deployed: null, runs: [] }),
  });
  return {
    [`${prefix}-unprovisioned`]: base(`${prefix}-unprovisioned`, `Reports service without its ${label}`, 'lab-reports', {
      namespaces: [{ name: FOREIGN_NAMESPACE, owned: false }],
      objects: [FOREIGN_OBJECT],
    }),
    [`${prefix}-misconfigured`]: base(`${prefix}-misconfigured`, `Reports service pointed at the wrong ${label}`, 'lab-report', {
      namespaces: [{ name: 'lab-reports', owned: true }, { name: FOREIGN_NAMESPACE, owned: false }],
      objects: [
        { namespace: 'lab-reports', key: 'daily-summary.txt', content: 'Daily summary\nrequests=1824\nerrors=0\n' },
        FOREIGN_OBJECT,
      ],
    }),
  };
}

export const fixtureCatalog = Object.freeze(Object.keys(fixtures));

export function getFixture(fixtureId) {
  const fixture = fixtures[fixtureId];
  if (!fixture) {
    throw new RangeError(`Unknown fixture: ${fixtureId}`);
  }
  return fixture;
}

export function createFixtureResources(fixtureId, { sessionId, generation, observedAt, source }) {
  return getFixture(fixtureId).services.map((service) => {
    const running = service.state === 'running';
    // The image healthcheck probes the expected port from inside the container.
    const health = service.health ??
      (running ? (service.appPort === service.expectedProbePort ? 'healthy' : 'unhealthy') : 'unknown');
    return {
      id: `${service.serviceId}-g${generation}`,
      sessionId,
      generation,
      serviceId: service.serviceId,
      kind: 'container',
      desired: {
        image: service.image,
        appPort: service.appPort,
        expectedProbePort: service.expectedProbePort,
        ...(service.storage ? { storage: { ...service.storage } } : {}),
      },
      observed: {
        state: service.state,
        health,
        image: service.image,
        exitCode: service.exitCode,
        startedAt: running ? new Date(Date.parse(observedAt) - 60_000).toISOString() : null,
        ports: [{ containerPort: service.appPort, hostPort: null }],
        source,
        observedAt,
        unavailableReason: null,
      },
    };
  });
}

/** Simulated pre-session log history for the fixture's services. */
export function createFixtureHistory(fixtureId, { now }) {
  const fixture = getFixture(fixtureId);
  const base = Date.parse(now);
  return fixture.services.flatMap((service) => fixture.history({ release: getRelease(service.image), service })
    .map(({ offset, ...line }) => ({
      serviceId: service.serviceId,
      ...line,
      at: new Date(base + offset * 1000).toISOString(),
    })));
}

/**
 * Release bookkeeping recorded before the session started. Real drivers pass
 * `source: null` because that history was not observed in the session.
 */
export function createFixturePipeline(fixtureId, { now, source = 'simulator' }) {
  return getFixture(fixtureId).pipeline({ base: Date.parse(now), source });
}

/**
 * Seed storage for cloud fixtures. The simulator keeps object content in the
 * snapshot; real backends seed their emulator and report metadata only.
 */
export async function createFixtureStorage(fixtureId, { now, source, withContent }) {
  const seed = getFixture(fixtureId).storage;
  if (!seed) {
    return null;
  }
  const profile = getStorageProvider(seed.provider);
  const createdAt = new Date(Date.parse(now) - 3_600_000).toISOString();
  const objects = [];
  for (const object of seed.objects) {
    objects.push({
      namespace: object.namespace,
      key: object.key,
      bytes: utf8Bytes(object.content),
      sha256: await sha256Hex(object.content),
      updatedAt: createdAt,
      writer: 'fixture',
      source,
      observedAt: now,
      ...(withContent ? { content: object.content } : {}),
    });
  }
  return {
    provider: seed.provider,
    endpoint: profile.endpoint,
    namespaces: seed.namespaces.map((namespace) => ({
      name: namespace.name, owned: namespace.owned, createdAt, source, observedAt: now,
    })),
    objects,
    roundTrips: [],
  };
}
