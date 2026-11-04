import { API_IMAGE, getRelease, workloadLines } from './releases.js';

const KNOWN_GOOD = `${API_IMAGE}:1.0.0`;

/**
 * Approved starting states. `history` lists log lines from before the session
 * started, with offsets in seconds relative to session creation.
 */
const fixtures = {
  'api-running': {
    id: 'api-running',
    label: 'Known-good API, running',
    services: [{ serviceId: 'api', image: KNOWN_GOOD, appPort: 3000, expectedProbePort: 3000, state: 'running', exitCode: null }],
    history: ({ release }) => [
      ...workloadLines.startup(release, 3000).map((line) => ({ ...line, offset: -60 })),
    ],
  },
  'api-stopped': {
    id: 'api-stopped',
    label: 'Known-good API, stopped',
    services: [{ serviceId: 'api', image: KNOWN_GOOD, appPort: 3000, expectedProbePort: 3000, state: 'stopped', exitCode: 0 }],
    history: ({ release }) => [
      ...workloadLines.startup(release, 3000).map((line) => ({ ...line, offset: -900 })),
      ...workloadLines.shutdown().map((line) => ({ ...line, offset: -120 })),
    ],
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
  return getFixture(fixtureId).services.map((service) => ({
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
      health: service.state === 'running' ? 'healthy' : 'unknown',
      image: service.image,
      exitCode: service.exitCode,
      startedAt: service.state === 'running' ? new Date(Date.parse(observedAt) - 60_000).toISOString() : null,
      ports: [{ containerPort: service.appPort, hostPort: null }],
      source,
      observedAt,
      unavailableReason: null,
    },
  }));
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
