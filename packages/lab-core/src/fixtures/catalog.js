import { API_IMAGE, getRelease, getReleaseById, releaseRef, workloadLines } from './releases.js';
import { STAGE_IDS } from '../schemas/pipeline.js';

const KNOWN_GOOD = `${API_IMAGE}:1.0.0`;
const DEFAULT_CANDIDATES = Object.freeze(['api-1-0-1', 'api-1-1-0']);

const verifiedBaseline = () => ({
  knownGood: releaseRef(getReleaseById('api-1-0-0')),
  deployed: { ...releaseRef(getReleaseById('api-1-0-0')), status: 'verified' },
  runs: [],
});

/** A recorded deployment of 1.1.0: tests and build passed, runtime verification failed. */
function failedCandidateRun(base) {
  const at = (offset) => new Date(base + offset * 1000).toISOString();
  const stage = (id, start, end, status, logs, exitCode = 0) => ({
    id, status, startedAt: at(start), finishedAt: at(end), durationMs: (end - start) * 1000, exitCode, logs, source: 'simulator',
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
    pipeline: ({ base }) => ({
      knownGood: releaseRef(getReleaseById('api-1-0-0')),
      deployed: { ...releaseRef(getReleaseById('api-1-1-0')), status: 'failed' },
      runs: [failedCandidateRun(base)],
    }),
  },
};

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

/** Release bookkeeping recorded before the session started. */
export function createFixturePipeline(fixtureId, { now }) {
  return getFixture(fixtureId).pipeline({ base: Date.parse(now) });
}
