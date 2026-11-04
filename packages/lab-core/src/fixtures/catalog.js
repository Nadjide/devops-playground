const API_IMAGE = 'devops-playground-lab/api';

const fixtures = {
  'api-stopped': {
    id: 'api-stopped',
    label: 'Known-good API, stopped',
    services: [{
      serviceId: 'api',
      image: `${API_IMAGE}:1.0.0`,
      appPort: 3000,
      expectedProbePort: 3000,
      state: 'stopped',
      exitCode: 0,
    }],
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
      health: 'unknown',
      image: service.image,
      exitCode: service.exitCode,
      startedAt: null,
      ports: [{ containerPort: service.appPort, hostPort: null }],
      source,
      observedAt,
      unavailableReason: null,
    },
  }));
}
