import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  eventSchema, labManifestSchema, operationRequestSchema, operationSchema,
  resourceSchema, sessionSchema,
} from '@devops-playground/lab-core';
import { makeEvent, makeManifest, makeOperation, makeResource, makeSession } from './helpers.js';

describe('runtime contracts', () => {
  it('validates the schema examples in the published master plan', () => {
    const plan = readFileSync(new URL('../../../DEVOPS_PLAYGROUND_MASTER_PLAN.md', import.meta.url), 'utf8');
    const examples = [...plan.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map((match) => JSON.parse(match[1]));
    const snapshot = examples.find((example) => example.lastEventSequence !== undefined);
    const event = examples.find((example) => example.sequence !== undefined);
    const manifest = examples.find((example) => example.allowedOperations !== undefined);
    const request = examples.find((example) => example.type === 'container.start');

    expect(sessionSchema.parse(snapshot)).toEqual(snapshot);
    expect(eventSchema.parse(event)).toEqual(event);
    expect(labManifestSchema.parse(manifest)).toEqual(manifest);
    expect(operationRequestSchema.parse(request)).toEqual(request);
  });

  it.each([
    ['container.start', { serviceId: 'api' }],
    ['container.stop', { serviceId: 'api' }],
    ['container.restart', { serviceId: 'api' }],
    ['container.inspect', { serviceId: 'api' }],
    ['container.logs', { serviceId: 'api', tail: 50 }],
    ['service.configure', { serviceId: 'api', appPort: 3000 }],
    ['health.probe', { serviceId: 'api' }],
    ['version.probe', { serviceId: 'api' }],
    ['pipeline.run', { releaseId: 'api-1-0-1' }],
    ['pipeline.cancel', {}],
    ['pipeline.rollback', {}],
    ['session.reset', {}],
    ['session.end', {}],
  ])('accepts the approved %s operation', (type, parameters) => {
    const request = { type, generation: 1, parameters };
    expect(operationRequestSchema.parse(request)).toEqual(request);
  });

  it.each([
    { type: 'container.exec', generation: 1, parameters: { command: 'sh' } },
    { type: 'container.start', generation: 1, parameters: { serviceId: '../../host' } },
    { type: 'container.start', generation: 1, parameters: { serviceId: 'api', privileged: true } },
    { type: 'health.probe', generation: 1, parameters: { serviceId: 'api', url: 'http://example.com' } },
    { type: 'service.configure', generation: 1, parameters: { serviceId: 'api', appPort: 80 } },
    { type: 'service.configure', generation: 1, parameters: { serviceId: 'api', appPort: 65536 } },
    { type: 'service.configure', generation: 1, parameters: { serviceId: 'api', appPort: '3000' } },
    { type: 'service.configure', generation: 1, parameters: { serviceId: 'api', appPort: 3000, expectedProbePort: 3001 } },
    { type: 'container.logs', generation: 1, parameters: { serviceId: 'api', tail: 201 } },
    { type: 'container.logs', generation: 1, parameters: { serviceId: 'api', tail: 0 } },
    { type: 'session.reset', generation: 0, parameters: {} },
    { type: 'session.end', generation: 1, parameters: { all: true } },
  ])('rejects unsupported or unsafe operation input %#', (request) => {
    expect(operationRequestSchema.safeParse(request).success).toBe(false);
  });

  it('normalizes the bounded log tail default', () => {
    expect(operationRequestSchema.parse({ type: 'container.logs', generation: 1, parameters: { serviceId: 'api' } })
      .parameters.tail).toBe(50);
  });

  it.each(['queued', 'running', 'succeeded', 'failed', 'cancelled'])('accepts a valid %s operation record', (status) => {
    expect(operationSchema.parse(makeOperation(status)).status).toBe(status);
  });

  it.each([
    makeOperation('running', { startedAt: null }),
    makeOperation('queued', { startedAt: '2026-11-04T10:00:01.000Z' }),
    makeOperation('failed', { error: null }),
    makeOperation('succeeded', { finishedAt: null }),
    makeOperation('succeeded', { finishedAt: '2026-11-04T09:00:00.000Z' }),
    makeOperation('succeeded', { result: { unsupported: () => {} } }),
  ])('rejects inconsistent operation lifecycle data %#', (operation) => {
    expect(operationSchema.safeParse(operation).success).toBe(false);
  });

  it('accepts a running container with an unhealthy application', () => {
    const resource = makeResource();
    resource.observed.state = 'running';
    resource.observed.health = 'unhealthy';
    expect(resourceSchema.parse(resource).observed.health).toBe('unhealthy');
  });

  it.each(['session', 'resource', 'operation', 'manifest', 'event'])('rejects unexpected fields in %s', (kind) => {
    const state = makeSession();
    const contracts = {
      session: [sessionSchema, state],
      resource: [resourceSchema, makeResource()],
      operation: [operationSchema, makeOperation()],
      manifest: [labManifestSchema, makeManifest()],
      event: [eventSchema, makeEvent(state)],
    };
    const [schema, value] = contracts[kind];
    expect(schema.safeParse({ ...value, unexpected: true }).success).toBe(false);
  });

  it.each([
    { schemaVersion: 1 },
    { revision: -1 },
    { eventEpoch: '../epoch' },
    { updatedAt: 'yesterday' },
    { updatedAt: '2025-01-01T00:00:00.000Z' },
    { resources: [makeResource({ sessionId: 'another-session' })] },
    { resources: [makeResource({ generation: 2 })] },
    { resources: [makeResource(), makeResource()] },
    { operations: [makeOperation('queued', { parameters: { serviceId: 'foreign' } })] },
  ])('rejects invalid session identity and resource references %#', (overrides) => {
    expect(sessionSchema.safeParse({ ...makeSession(), ...overrides }).success).toBe(false);
  });

  it('rejects simulated observations in local mode', () => {
    expect(sessionSchema.safeParse({ ...makeSession(), mode: 'local' }).success).toBe(false);
  });

  it('rejects actual observations in demo mode', () => {
    const state = makeSession();
    state.resources[0].observed.source = 'docker';
    expect(sessionSchema.safeParse(state).success).toBe(false);
  });

  it('rejects evidence from another generation', () => {
    const state = makeSession();
    state.mission.objectives[0].status = 'satisfied';
    state.mission.objectives[0].evidence = {
      eventId: 'old-evidence', generation: 2, revision: 0, source: 'simulator',
      observedAt: state.updatedAt, explanation: 'Stale evidence',
    };
    expect(sessionSchema.safeParse(state).success).toBe(false);
  });

  it.each(['objectives', 'supportedModes', 'allowedOperations'])('rejects duplicate manifest %s', (field) => {
    const manifest = makeManifest();
    manifest[field].push(manifest[field][0]);
    expect(labManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('rejects unregistered predicate identifiers and executable fixture paths', () => {
    const manifest = makeManifest();
    manifest.objectives[0].predicateId = 'eval';
    expect(labManifestSchema.safeParse(manifest).success).toBe(false);
    manifest.objectives[0].predicateId = 'evidence.logs-read';
    manifest.fixtureId = '../../server.js';
    expect(labManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('rejects fabricated event IDs and mismatched operation events', () => {
    const state = makeSession();
    expect(eventSchema.safeParse({ ...makeEvent(state), id: 'fabricated' }).success).toBe(false);
    const event = makeEvent(state, {
      type: 'operation.started', operationId: 'other-operation',
      payload: { operation: makeOperation('queued') },
    });
    expect(eventSchema.safeParse(event).success).toBe(false);
  });
});
