import { describe, expect, it } from 'vitest';
import {
  createLabRuntime, createSimulatorExecutor, createVirtualClock, MAX_CHECKPOINT_BYTES,
  parseCheckpoint, serializeCheckpoint, SIMULATED_TIMINGS,
} from '../src/index.js';
import { startRuntime } from './runtime-helpers.js';

async function restore(snapshot, options = {}) {
  const clock = createVirtualClock(Date.parse(snapshot.updatedAt) + 5_000);
  let counter = 1000;
  const runtime = createLabRuntime({
    labId: snapshot.labId,
    fixtureId: snapshot.fixtureId,
    executor: createSimulatorExecutor(),
    clock,
    nextId: () => `restored-${++counter}`,
    ...options,
  });
  await runtime.start({ restore: snapshot });
  return { runtime, clock };
}

describe('checkpoint serialization', () => {
  it('round-trips a demo session through text', async () => {
    const { run, valid } = await startRuntime();
    await run('container.logs', { serviceId: 'api', tail: 50 });
    const saved = serializeCheckpoint(valid(), { now: () => '2026-11-04T10:05:00.000Z' });
    expect(saved).toMatchObject({ ok: true });
    expect(saved.bytes).toBeLessThanOrEqual(MAX_CHECKPOINT_BYTES);
    const parsed = parseCheckpoint(saved.text);
    expect(parsed).toMatchObject({ ok: true, checkpoint: { checkpointVersion: 2, savedAt: '2026-11-04T10:05:00.000Z' }, migratedFrom: null });
    expect(parsed.checkpoint.session).toEqual(valid());
  });

  it.each([
    [null, 'empty'],
    ['{not json', 'malformed'],
    [JSON.stringify({ checkpointVersion: 3, session: { schemaVersion: 2 } }), 'incompatible'],
    [JSON.stringify({ checkpointVersion: 2, session: { schemaVersion: 1 } }), 'incompatible'],
    [JSON.stringify({ checkpointVersion: 1, session: { schemaVersion: 2 } }), 'incompatible'],
    [JSON.stringify({ checkpointVersion: 1, savedAt: '2026-11-04T10:00:00.000Z', session: { schemaVersion: 1, id: 'x' } }), 'invalid'],
    ['x'.repeat(MAX_CHECKPOINT_BYTES + 1), 'oversized'],
  ])('reports unusable saved text %# as %s', (text, reason) => {
    expect(parseCheckpoint(text)).toMatchObject({ ok: false, reason, message: expect.any(String) });
  });

  it('rejects tampered snapshots that break domain invariants', async () => {
    const { valid } = await startRuntime();
    const session = valid();
    const tampered = { ...session, resources: [{ ...session.resources[0], observed: { ...session.resources[0].observed, source: 'docker' } }] };
    const text = JSON.stringify({ checkpointVersion: 2, savedAt: session.updatedAt, session: tampered });
    expect(parseCheckpoint(text)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('migrates a version 1 checkpoint from before cloud storage', async () => {
    const { run, valid } = await startRuntime();
    await run('container.logs', { serviceId: 'api', tail: 50 });
    const { storage, ...legacy } = { ...valid(), schemaVersion: 1 };
    expect(storage).toBeNull();
    const parsed = parseCheckpoint(JSON.stringify({ checkpointVersion: 1, savedAt: legacy.updatedAt, session: legacy }));
    expect(parsed).toMatchObject({ ok: true, migratedFrom: 1, checkpoint: { checkpointVersion: 2 } });
    expect(parsed.checkpoint.session).toEqual(valid());
  });

  it('refuses version 1 checkpoints that already carry storage state', async () => {
    const { valid } = await startRuntime();
    const legacy = { ...valid(), schemaVersion: 1, storage: { provider: 'aws-s3' } };
    const parsed = parseCheckpoint(JSON.stringify({ checkpointVersion: 1, savedAt: legacy.updatedAt, session: legacy }));
    expect(parsed).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('restoring a checkpoint', () => {
  it('restores progress and keeps satisfied evidence of the same generation', async () => {
    const { run, valid } = await startRuntime();
    await run('container.logs', { serviceId: 'api', tail: 50 });
    await run('container.start', { serviceId: 'api' });
    const { runtime } = await restore(valid());
    const session = runtime.getSession();
    expect(session.mission.objectives.map((objective) => objective.status)).toEqual(['satisfied', 'satisfied', 'pending']);
    expect(session.resources[0].observed.state).toBe('running');
    expect(session.logs.entries.at(-1).message).toMatch(/restored from a browser checkpoint/);
  });

  it('cancels work that was running when the page closed, then allows reset', async () => {
    const { submit, clock, valid } = await startRuntime({ labId: 'free-exploration' });
    submit('pipeline.run', { releaseId: 'api-1-0-1' });
    submit('container.inspect', { serviceId: 'api' });
    await clock.advance(SIMULATED_TIMINGS.validate + 50);
    const { runtime, clock: restoredClock } = await restore(valid());
    const session = runtime.getSession();
    expect(session.operations.every((operation) => !['queued', 'running'].includes(operation.status))).toBe(true);
    expect(session.pipeline.runs.at(-1)).toMatchObject({ status: 'cancelled' });
    expect(session.pipeline.runs.at(-1).stages.map((stage) => stage.status))
      .toEqual(['passed', 'cancelled', 'skipped', 'skipped', 'skipped']);

    const reset = runtime.submit({ type: 'session.reset', generation: 1, parameters: {} }, { idempotencyKey: 'reset-after-reload' });
    const settled = runtime.settled(reset.id);
    await restoredClock.runAll();
    expect(await settled).toMatchObject({ status: 'succeeded', result: { generation: 2 } });
  });

  it('does not report an interrupted start as running', async () => {
    const { submit, clock, valid } = await startRuntime();
    submit('container.start', { serviceId: 'api' });
    await clock.advance(SIMULATED_TIMINGS.startup / 2);
    expect(valid().resources[0].observed.state).toBe('starting');
    const { runtime } = await restore(valid());
    expect(runtime.getSession().resources[0].observed).toMatchObject({
      state: 'stopped', unavailableReason: 'Startup was interrupted by a page reload.',
    });
  });

  it('refuses a checkpoint for another lab', async () => {
    const { valid } = await startRuntime();
    const runtime = createLabRuntime({ labId: 'wrong-port', executor: createSimulatorExecutor(), clock: createVirtualClock() });
    await expect(runtime.start({ restore: valid() })).rejects.toMatchObject({ code: 'CHECKPOINT_MISMATCH' });
  });
});
