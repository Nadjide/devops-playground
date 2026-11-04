import { describe, expect, it } from 'vitest';
import { createFixtureResources, sessionSchema } from '@devops-playground/lab-core';
import { recoveredSnapshot } from '../src/sessions/recovery.js';
import { createBrowser, createTestApp, dockerShapedExecutor, fakeRunner } from './helpers.js';
import { createControlApp } from '../src/app.js';

function recoveredPayload(sessionId = 'orphan-session', generation = 3) {
  const resources = createFixtureResources('api-running', { sessionId, generation, observedAt: '2026-11-04T10:00:00.000Z', source: 'docker' });
  return {
    session: { id: sessionId, generation, labId: 'stopped-container', fixtureId: 'api-stopped' },
    resources: resources.map((resource) => ({ ...resource })),
    logs: [{ serviceId: 'api', stream: 'stdout', level: 'info', message: 'DevOps Playground API 1.0.0 listening on port 3000', at: '2026-11-04T09:59:00.000Z' }],
  };
}

describe('recovered snapshots', () => {
  it('keeps identity and generation, starts a new epoch, and marks evidence unverified', () => {
    const snapshot = recoveredSnapshot({ recovered: recoveredPayload(), nextId: () => 'epoch-new', now: '2026-11-04T10:00:05.000Z' });
    expect(sessionSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot).toMatchObject({
      id: 'orphan-session', generation: 3, eventEpoch: 'epoch-new', mode: 'local', status: 'active',
      mission: { status: 'not-started', completion: null },
      pipeline: { knownGood: { releaseId: 'api-1-0-0' }, deployed: { releaseId: 'api-1-0-0', status: 'unverified' }, runs: [] },
    });
    expect(snapshot.mission.objectives.every((objective) => objective.status === 'pending')).toBe(true);
  });
});

describe('recovery endpoint', () => {
  function recoveryApp({ recover = async () => recoveredPayload(), cleanup = async () => ({ removed: ['dpg-orphan-g3-api', 'dpg-orphan-g3'], remaining: [] }) } = {}) {
    const runner = {
      ...fakeRunner(),
      inventory: async () => ({ ok: true, body: { sessions: [{ sessionId: 'orphan-session', generation: 3, labId: 'stopped-container', fixtureId: 'api-stopped', containers: [], networks: [] }] } }),
      metrics: async () => ({ ok: true, body: { samples: [{ serviceId: 'api', available: true, cpuPercent: 1.5, memoryBytes: 1, memoryLimitBytes: 268435456, pids: 7, observedAt: '2026-11-04T10:00:00.000Z', source: 'docker' }] } }),
    };
    const base = createTestApp({ runner });
    const executorFactory = () => ({ ...dockerShapedExecutor(), recover, cleanup });
    const app = createControlApp({ config: base.config, store: base.store, runner, operations: [], executorFactory, logger: { error() {} } });
    return { app, store: base.store };
  }

  it('lists recoverable sessions and re-adopts one with re-observed resources', async () => {
    const { app } = recoveryApp();
    const browser = await createBrowser(app);
    expect((await browser.get('/api/capabilities')).body.recoverable).toEqual([expect.objectContaining({ sessionId: 'orphan-session', generation: 3 })]);
    const recovered = await browser.post('/api/recovery/orphan-session', { action: 'recover' });
    expect(recovered.status).toBe(201);
    expect(recovered.body.session).toMatchObject({ id: 'orphan-session', generation: 3, status: 'active' });
    expect(recovered.body.session.logs.entries.map((entry) => entry.message)).toEqual(expect.arrayContaining([
      'DevOps Playground API 1.0.0 listening on port 3000',
      'Session recovered after a controller restart from label-verified resources; objectives need fresh evidence.',
    ]));
    expect((await browser.get('/api/sessions')).body.sessions).toHaveLength(1);
    const again = await browser.post('/api/recovery/orphan-session', { action: 'recover' });
    expect(again.status).toBe(409);
    expect((await browser.get(`/api/sessions/orphan-session/metrics`)).body.samples[0]).toMatchObject({ cpuPercent: 1.5, memoryLimitBytes: 268435456 });
  });

  it('cleans up instead of recovering and validates the action', async () => {
    const { app } = recoveryApp();
    const browser = await createBrowser(app);
    expect((await browser.post('/api/recovery/orphan-session', { action: 'delete-everything' })).status).toBe(400);
    expect((await browser.post('/api/recovery/orphan-session', { action: 'recover' }, { csrf: '' })).status).toBe(403);
    const cleanup = await browser.post('/api/recovery/orphan-session', { action: 'cleanup' });
    expect(cleanup.body.cleanup).toEqual({ removed: ['dpg-orphan-g3-api', 'dpg-orphan-g3'], remaining: [] });
  });

  it('reports incomplete ownership as a conflict', async () => {
    const failure = Object.assign(new Error('No recoverable resources with complete ownership labels exist for this session.'), {
      status: 409, code: 'RECOVERY_UNAVAILABLE', retryable: false,
    });
    const { app } = recoveryApp({ recover: async () => { throw failure; } });
    const response = await (await createBrowser(app)).post('/api/recovery/orphan-session', { action: 'recover' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('RECOVERY_UNAVAILABLE');
  });
});
