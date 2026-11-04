// Recovery and lifecycle against real Docker: controller crash, runner
// interruption, concurrent work, metrics, scoped cleanup, and a stress cycle.
import { spawnSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowser, docker, endIfOpen, launcher, ownedContainers } from './client.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CONTROL = 'devops-playground-control-1';
const RUNNER = 'devops-playground-runner-1';
const allOwned = () => docker('ps', '-aq', '--filter', 'label=devops-playground.managed=true', '--filter', 'label=devops-playground.role=workload');
const ownedNetworks = () => docker('network', 'ls', '-q', '--filter', 'label=devops-playground.managed=true');

async function waitHealthy(name) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (docker('inspect', name, '--format', '{{.State.Health.Status}}') === 'healthy') {
      return;
    }
    await sleep(500);
  }
  throw new Error(`${name} did not become healthy`);
}

/** Simulate a crash (SIGKILL skips the graceful session shutdown), then restart. */
async function crashAndRestart(name) {
  docker('kill', '--signal', 'SIGKILL', name);
  docker('start', name);
  await waitHealthy(name);
}

describe('local recovery and lifecycle', { timeout: 25 * 60_000 }, () => {
  before(() => {
    launcher('down');
    launcher('local');
  });

  after(() => {
    launcher('down');
  });

  it('recovers a session after a controller crash without trusting stale evidence', async () => {
    let browser = await createBrowser().connect();
    const session = await browser.createSession('stopped-container');
    try {
      assert.equal((await browser.run(session.id, 'container.start', { serviceId: 'api' })).status, 'succeeded');
      assert.equal((await browser.run(session.id, 'health.probe', { serviceId: 'api' })).status, 'succeeded');
      const before = await browser.session(session.id);
      assert.equal(before.mission.objectives.find((item) => item.id === 'verify-health').status, 'satisfied');

      await crashAndRestart(CONTROL);
      browser = await createBrowser().connect();
      assert.deepEqual((await browser.request('GET', '/api/sessions')).body.sessions, []);
      const capabilities = (await browser.request('GET', '/api/capabilities')).body;
      assert.ok(capabilities.recoverable.some((item) => item.sessionId === session.id && item.generation === 1));

      const recovered = await browser.request('POST', `/api/recovery/${session.id}`, { body: { action: 'recover' } });
      assert.equal(recovered.status, 201);
      const state = recovered.body.session;
      assert.equal(state.id, session.id);
      assert.equal(state.generation, 1);
      assert.notEqual(state.eventEpoch, before.eventEpoch);
      assert.equal(state.resources[0].observed.state, 'running', 'the real container is re-observed');
      assert.equal(state.mission.objectives.find((item) => item.id === 'verify-health').status, 'pending', 'evidence needs re-observation');

      assert.equal((await browser.run(session.id, 'health.probe', { serviceId: 'api' })).status, 'succeeded');
      const metrics = await browser.request('GET', `/api/sessions/${session.id}/metrics`);
      assert.equal(metrics.status, 200);
      assert.equal(metrics.body.samples[0].available, true);
      assert.equal(metrics.body.samples[0].memoryLimitBytes, 256 * 1024 * 1024);
      assert.ok(metrics.body.samples[0].cpuPercent >= 0);
    } finally {
      await endIfOpen(browser, session.id);
    }
    assert.deepEqual(ownedContainers(session.id), []);
  });

  it('cleans up orphaned resources instead of recovering them', async () => {
    let browser = await createBrowser().connect();
    const session = await browser.createSession('wrong-port');
    await crashAndRestart(CONTROL);
    browser = await createBrowser().connect();
    const cleanup = await browser.request('POST', `/api/recovery/${session.id}`, { body: { action: 'cleanup' } });
    assert.equal(cleanup.status, 200);
    assert.ok(cleanup.body.cleanup.removed.some((name) => name.endsWith('-api')));
    assert.deepEqual(cleanup.body.cleanup.remaining, []);
    assert.deepEqual(ownedContainers(session.id), []);
    assert.equal((await browser.request('GET', '/api/capabilities')).body.recoverable.length, 0);
  });

  it('fails operations clearly while the runner is down and resumes without duplicating logs', async () => {
    const browser = await createBrowser().connect();
    const session = await browser.createSession('stopped-container');
    try {
      assert.equal((await browser.run(session.id, 'container.logs', { serviceId: 'api', tail: 50 })).status, 'succeeded');
      const count = async () => (await browser.session(session.id)).logs.entries
        .filter((entry) => entry.message === 'HTTP server closed, exiting with code 0').length;
      assert.equal(await count(), 1);

      docker('kill', '--signal', 'SIGKILL', RUNNER);
      const down = await browser.run(session.id, 'container.inspect', { serviceId: 'api' });
      assert.equal(down.status, 'failed');
      assert.equal(down.error.retryable, true);
      assert.equal((await browser.session(session.id)).status, 'active');

      docker('start', RUNNER);
      await waitHealthy(RUNNER);
      assert.equal((await browser.run(session.id, 'container.logs', { serviceId: 'api', tail: 50 })).status, 'succeeded');
      assert.equal(await count(), 1, 'log lines are not ingested twice after a runner restart');
      assert.equal((await browser.run(session.id, 'container.start', { serviceId: 'api' })).status, 'succeeded');
    } finally {
      await endIfOpen(browser, session.id);
    }
  });

  it('serializes a reset submitted with a stop into one reconciled new generation', async () => {
    const browser = await createBrowser().connect();
    const session = await browser.createSession('wrong-port');
    try {
      const [stop, reset] = await Promise.all([
        browser.run(session.id, 'container.stop', { serviceId: 'api' }),
        browser.run(session.id, 'session.reset'),
      ]);
      assert.ok(['succeeded', 'cancelled', 'failed'].includes(stop.status) || stop.rejected);
      assert.equal(reset.status, 'succeeded');
      const state = await browser.session(session.id);
      assert.equal(state.generation, 2);
      assert.equal(state.status, 'active');
      const containers = ownedContainers(session.id);
      assert.equal(containers.length, 1);
      assert.equal(docker('inspect', containers[0].id, '--format', '{{index .Config.Labels "devops-playground.generation"}}'), '2');
      assert.equal(docker('network', 'ls', '-q', '--filter', `label=devops-playground.session=${session.id}`).split('\n').filter(Boolean).length, 1);
    } finally {
      await endIfOpen(browser, session.id);
    }
  });

  it('removes only this installation\'s orphans with the launcher cleanup command', async () => {
    const browser = await createBrowser().connect();
    const session = await browser.createSession('stopped-container');
    const foreign = docker('run', '-d', '--label', 'devops-playground.integration-fixture=foreign', '--label', 'devops-playground.managed=true',
      '--label', 'devops-playground.installation=foreign-install', '--label', 'devops-playground.role=workload', 'node:22-alpine', 'sleep', '600');
    try {
      docker('kill', '--signal', 'SIGKILL', CONTROL);
      const result = spawnSync(process.execPath, ['scripts/playground.js', 'cleanup'], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Removed \d+ container\(s\) and \d+ network\(s\)/);
      assert.deepEqual(ownedContainers(session.id), []);
      assert.equal(docker('inspect', foreign, '--format', '{{.State.Running}}'), 'true');
    } finally {
      docker('rm', '-f', foreign);
      docker('start', CONTROL);
      await waitHealthy(CONTROL);
    }
  });

  it('runs 10 create, reset, and end cycles without leaking owned resources', async () => {
    const browser = await createBrowser().connect();
    for (let cycle = 0; cycle < 10; cycle += 1) {
      const session = await browser.createSession('stopped-container');
      assert.equal((await browser.run(session.id, 'session.reset')).status, 'succeeded');
      assert.equal(ownedContainers(session.id).length, 1);
      assert.equal((await browser.run(session.id, 'session.end')).status, 'succeeded');
      assert.deepEqual(ownedContainers(session.id), []);
    }
    assert.equal(allOwned(), '');
    assert.equal(ownedNetworks(), '');
  });
});
