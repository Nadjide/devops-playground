import { describe, expect, it } from 'vitest';
import {
  createFixtureResources, createLabSession, getFixture, getLabManifest,
  labCatalog, labManifestSchema, sessionSchema,
} from '../src/index.js';

describe('lab catalog', () => {
  it('exposes validated manifests from the labs directory', () => {
    expect(labCatalog.map((lab) => lab.id)).toContain('stopped-container');
    for (const lab of labCatalog) {
      expect(labManifestSchema.parse(lab)).toEqual(lab);
      expect(() => getFixture(lab.fixtureId)).not.toThrow();
    }
  });

  it('rejects unknown lab and fixture identifiers', () => {
    expect(() => getLabManifest('../etc/passwd')).toThrow(RangeError);
    expect(() => getFixture('unknown-fixture')).toThrow(RangeError);
  });
});

describe('createLabSession', () => {
  it('creates an initializing demo session with owned fixture resources', () => {
    const ids = ['session-demo', 'epoch-demo'];
    const session = createLabSession({
      labId: 'stopped-container',
      now: () => '2026-11-04T10:00:00.000Z',
      nextId: () => ids.shift(),
    });
    expect(sessionSchema.parse(session)).toEqual(session);
    expect(session).toMatchObject({ id: 'session-demo', eventEpoch: 'epoch-demo', status: 'initializing', mode: 'demo' });
    expect(session.resources).toHaveLength(1);
    expect(session.resources[0]).toMatchObject({
      sessionId: 'session-demo', generation: 1, serviceId: 'api',
      observed: { state: 'stopped', health: 'unknown', source: 'simulator' },
    });
    expect(session.mission.objectives.every((objective) => objective.status === 'pending')).toBe(true);
  });

  it('uses runtime provenance for local fixture resources', () => {
    const [resource] = createFixtureResources('api-stopped', {
      sessionId: 'session-local', generation: 2, observedAt: '2026-11-04T10:00:00.000Z', source: 'docker',
    });
    expect(resource).toMatchObject({ id: 'api-g2', generation: 2, observed: { source: 'docker' } });
  });
});
