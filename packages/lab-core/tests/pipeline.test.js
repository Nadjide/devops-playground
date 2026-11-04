import { describe, expect, it } from 'vitest';
import {
  createSimulatorExecutor, DomainError, getFixture, PIPELINE_LIMITS, PREDICATES, SIMULATED_TIMINGS,
} from '../src/index.js';
import { startRuntime } from './runtime-helpers.js';

const statuses = (run) => run.stages.map((stage) => `${stage.id}:${stage.status}`);
const latestRun = (session) => session.pipeline.runs.at(-1);

describe('M03 broken release fixture', () => {
  it('starts after a failed deployment with the known-good release recorded', async () => {
    const { api, valid } = await startRuntime({ labId: 'broken-release' });
    const session = valid();
    expect(api()).toMatchObject({ desired: { image: 'devops-playground-lab/api:1.1.0' }, observed: { state: 'exited', exitCode: 1 } });
    expect(session.pipeline.knownGood).toMatchObject({ releaseId: 'api-1-0-0', version: '1.0.0' });
    expect(session.pipeline.deployed).toMatchObject({ releaseId: 'api-1-1-0', status: 'failed' });
    expect(statuses(latestRun(session))).toEqual(['validate:passed', 'test:passed', 'build:passed', 'deploy:passed', 'verify:failed']);
    expect(session.logs.entries.map((entry) => entry.message)).toContain('Startup aborted, exiting with code 1');
  });

  it('rolls back, verifies version and health, and completes with diagnostic evidence', async () => {
    const { run, api, valid } = await startRuntime({ labId: 'broken-release' });
    const rollback = await run('pipeline.rollback');
    expect(rollback).toMatchObject({ status: 'succeeded', result: { kind: 'rollback', status: 'passed' } });
    const session = valid();
    expect(statuses(latestRun(session))).toEqual(['validate:passed', 'test:skipped', 'build:skipped', 'deploy:passed', 'verify:passed']);
    expect(session.pipeline.deployed).toMatchObject({ releaseId: 'api-1-0-0', status: 'verified' });
    expect(api()).toMatchObject({ desired: { image: 'devops-playground-lab/api:1.0.0' }, observed: { state: 'running' } });
    // The verify stage probes satisfy the technical objectives; evidence reading is still required.
    const objective = (id) => session.mission.objectives.find((item) => item.id === id).status;
    expect(objective('restore-version')).toBe('satisfied');
    expect(objective('verify-health')).toBe('satisfied');
    expect(session.mission.status).toBe('in-progress');
    await run('container.logs', { serviceId: 'api', tail: 50 });
    expect(valid().mission.status).toBe('completed');
  });

  it('only deploys the approved candidate', async () => {
    const { run } = await startRuntime({ labId: 'broken-release' });
    const operation = await run('pipeline.run', { releaseId: 'api-1-0-1' });
    expect(operation).toMatchObject({ status: 'failed', error: { code: 'RELEASE_NOT_APPROVED' } });
  });
});

describe('simulated delivery pipeline', () => {
  it('passes tests and build for the broken candidate, then fails runtime verification', async () => {
    const { run, api, valid } = await startRuntime({ labId: 'free-exploration' });
    const operation = await run('pipeline.run', { releaseId: 'api-1-1-0' });
    expect(operation).toMatchObject({ status: 'failed', error: { code: 'PIPELINE_STAGE_FAILED' } });
    const session = valid();
    const latest = latestRun(session);
    expect(statuses(latest)).toEqual(['validate:passed', 'test:passed', 'build:passed', 'deploy:passed', 'verify:failed']);
    expect(latest.failureReason).toMatch(/GET \/health did not succeed within 4 attempts .*exited with code 1/);
    expect(latest.stages.find((stage) => stage.id === 'test').logs).toContain('Tests: 3 passed, 3 total');
    expect(session.pipeline.knownGood).toMatchObject({ releaseId: 'api-1-0-0' });
    expect(session.pipeline.deployed).toMatchObject({ releaseId: 'api-1-1-0', status: 'failed' });
    expect(api().observed).toMatchObject({ state: 'exited', exitCode: 1 });
    expect(session.probes.filter((probe) => probe.kind === 'health')).toHaveLength(SIMULATED_TIMINGS.verifyAttempts);
  });

  it('records stage durations from the injected clock', async () => {
    const { run, valid } = await startRuntime({ labId: 'free-exploration' });
    await run('pipeline.run', { releaseId: 'api-1-0-1' });
    const stages = latestRun(valid()).stages;
    expect(stages.find((stage) => stage.id === 'test').durationMs).toBe(SIMULATED_TIMINGS.test);
    expect(stages.find((stage) => stage.id === 'build').durationMs).toBe(SIMULATED_TIMINGS.build);
    expect(stages.every((stage) => stage.source === 'simulator')).toBe(true);
  });

  it('promotes a verified release to known-good and keeps version and health distinct', async () => {
    const { run, valid } = await startRuntime({ labId: 'free-exploration' });
    expect((await run('pipeline.run', { releaseId: 'api-1-0-1' })).status).toBe('succeeded');
    const session = valid();
    expect(session.pipeline).toMatchObject({
      knownGood: { releaseId: 'api-1-0-1' },
      deployed: { releaseId: 'api-1-0-1', status: 'verified' },
    });
    // A healthy 1.0.1 must not satisfy a 1.0.0 version objective.
    const context = { session, fixture: getFixture('api-broken-release'), nowMs: Date.parse(session.updatedAt), previous: { status: 'pending' } };
    expect(PREDICATES['service.health-verified'].evaluate(context).holds).toBe(true);
    expect(PREDICATES['service.version-verified'].evaluate(context).holds).toBe(false);
  });

  it('rejects a duplicate run and bounds run history', async () => {
    const { run, submit, clock, valid } = await startRuntime({ labId: 'free-exploration' });
    submit('pipeline.run', { releaseId: 'api-1-0-1' });
    expect(() => submit('pipeline.run', { releaseId: 'api-1-0-1' })).toThrow(expect.objectContaining({ code: 'PIPELINE_BUSY', status: 409 }));
    await clock.runAll();
    for (let index = 0; index < PIPELINE_LIMITS.runs + 1; index += 1) {
      await run('pipeline.run', { releaseId: index % 2 ? 'api-1-0-1' : 'api-1-1-0' });
    }
    expect(valid().pipeline.runs).toHaveLength(PIPELINE_LIMITS.runs);
  });

  it('refuses rollback when the known-good release is already verified', async () => {
    const { run } = await startRuntime({ labId: 'free-exploration' });
    expect(await run('pipeline.rollback')).toMatchObject({ status: 'failed', error: { code: 'ALREADY_ON_KNOWN_GOOD' } });
  });
});

describe('pipeline cancellation', () => {
  it('cancels before deploy without touching the running service', async () => {
    const { runtime, submit, clock, api, valid } = await startRuntime({ labId: 'free-exploration' });
    const pipeline = submit('pipeline.run', { releaseId: 'api-1-0-1' });
    await clock.advance(SIMULATED_TIMINGS.validate + 100);
    expect(latestRun(valid()).stages.find((stage) => stage.id === 'test').status).toBe('running');

    const cancel = submit('pipeline.cancel');
    const settled = runtime.settled(cancel.id);
    await clock.runAll();
    expect(await settled).toMatchObject({ status: 'succeeded', result: { cancelled: pipeline.id } });
    expect(runtime.getOperation(pipeline.id).status).toBe('cancelled');
    expect(statuses(latestRun(valid()))).toEqual(['validate:passed', 'test:cancelled', 'build:skipped', 'deploy:skipped', 'verify:skipped']);
    expect(latestRun(valid()).status).toBe('cancelled');
    expect(api()).toMatchObject({ desired: { image: 'devops-playground-lab/api:1.0.0' }, observed: { state: 'running' } });
  });

  it('refuses cancellation once deploy has started and when nothing runs', async () => {
    const { submit, clock } = await startRuntime({ labId: 'free-exploration' });
    expect(() => submit('pipeline.cancel')).toThrow(expect.objectContaining({ code: 'NOTHING_TO_CANCEL' }));
    submit('pipeline.run', { releaseId: 'api-1-0-1' });
    await clock.advance(SIMULATED_TIMINGS.validate + SIMULATED_TIMINGS.test + SIMULATED_TIMINGS.build + 100);
    let caught;
    try {
      submit('pipeline.cancel');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect(caught).toMatchObject({ code: 'CANCEL_UNSAFE', status: 409 });
    await clock.runAll();
  });

  it('reconciles a run interrupted by reset and restores the fixture pipeline', async () => {
    const { run, submit, clock, valid } = await startRuntime({ labId: 'broken-release' });
    submit('pipeline.rollback');
    await clock.advance(SIMULATED_TIMINGS.validate + 50);
    await run('session.reset');
    const session = valid();
    expect(session.generation).toBe(2);
    expect(session.pipeline.runs).toHaveLength(1);
    expect(session.pipeline.deployed).toMatchObject({ releaseId: 'api-1-1-0', status: 'failed' });
  });
});

describe('rollback failure', () => {
  it('retains both failure reasons and the remaining resources', async () => {
    const executor = createSimulatorExecutor({ faults: { 'api-1-0-0': 'crash' } });
    const { run, api, valid } = await startRuntime({ labId: 'broken-release', executor });
    const rollback = await run('pipeline.rollback');
    expect(rollback).toMatchObject({ status: 'failed', error: { code: 'PIPELINE_STAGE_FAILED' } });
    const runs = valid().pipeline.runs;
    expect(runs.map((item) => [item.kind, item.status])).toEqual([['deploy', 'failed'], ['rollback', 'failed']]);
    expect(runs.every((item) => item.failureReason)).toBe(true);
    expect(valid().pipeline.deployed).toMatchObject({ releaseId: 'api-1-0-0', status: 'failed' });
    expect(api().observed).toMatchObject({ state: 'exited', exitCode: 1 });
    expect(valid().mission).toMatchObject({ status: 'in-progress', completion: null });
  });
});
