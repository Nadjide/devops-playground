// Real local pipeline: disposable test containers, Engine API builds, deploys,
// verification, rollback, and cancellation against the packaged portal.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { containerLogs, createBrowser, docker, launcher, ownedContainers, withSession } from './client.mjs';

const stages = (run) => run.stages.map((stage) => `${stage.id}:${stage.status}`);
const latest = (session) => session.pipeline.runs.at(-1);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const testContainers = () => docker('ps', '-aq', '--filter', 'label=devops-playground.role=pipeline-test');

describe('local Docker pipeline', { timeout: 20 * 60_000 }, () => {
  before(() => {
    launcher('down');
    launcher('local');
  });

  after(() => {
    launcher('down');
  });

  it('completes M03 by rolling back the failed release to 1.0.0', async () => {
    const browser = await createBrowser().connect();
    await withSession(browser, 'broken-release', async (session) => {
      const [container] = ownedContainers(session.id);
      assert.equal(docker('inspect', container.id, '--format', '{{.State.Status}} {{.State.ExitCode}} {{.Config.Image}}'),
        'exited 1 devops-playground-lab/api:1.1.0');
      assert.match(containerLogs(container.id), /FEATURE_FLAGS_URL is required by release 1\.1\.0/);
      let state = await browser.session(session.id);
      assert.deepEqual(state.pipeline.deployed, { releaseId: 'api-1-1-0', image: 'devops-playground-lab/api:1.1.0', version: '1.1.0', status: 'failed' });
      assert.equal(latest(state).stages[0].source, null, 'fixture history is not presented as an observation');

      assert.equal((await browser.run(session.id, 'container.logs', { serviceId: 'api', tail: 50 })).status, 'succeeded');
      const rollback = await browser.run(session.id, 'pipeline.rollback');
      assert.equal(rollback.status, 'succeeded', JSON.stringify(rollback.error));
      state = await browser.session(session.id);
      assert.deepEqual(stages(latest(state)), ['validate:passed', 'test:skipped', 'build:skipped', 'deploy:passed', 'verify:passed']);
      assert.equal(latest(state).stages.at(-1).source, 'docker');
      assert.equal(state.pipeline.deployed.status, 'verified');
      const [restored] = ownedContainers(session.id);
      assert.equal(docker('inspect', restored.id, '--format', '{{.Config.Image}} {{.State.Running}}'), 'devops-playground-lab/api:1.0.0 true');
      assert.equal(state.mission.status, 'completed');
      assert.ok(state.probes.some((probe) => probe.kind === 'version' && probe.body?.version === '1.0.0' && probe.source === 'probe'));
    });
  });

  it('runs real tests and builds, fails runtime verification for 1.1.0, and rejects arbitrary input', async () => {
    const browser = await createBrowser().connect();
    await withSession(browser, 'free-exploration', async (session) => {
      const unapproved = await browser.run(session.id, 'pipeline.run', { releaseId: 'evil-release' });
      assert.equal(unapproved.status, 'failed');
      assert.equal(unapproved.error.code, 'RELEASE_NOT_APPROVED');
      const injected = await browser.request('POST', `/api/sessions/${session.id}/operations`, {
        body: { type: 'pipeline.run', generation: 1, parameters: { releaseId: 'api-1-0-1', dockerfile: 'FROM alpine' } }, key: 'inject-1',
      });
      assert.equal(injected.status, 400);

      const run = await browser.run(session.id, 'pipeline.run', { releaseId: 'api-1-1-0' });
      assert.equal(run.status, 'failed');
      let state = await browser.session(session.id);
      assert.deepEqual(stages(latest(state)), ['validate:passed', 'test:passed', 'build:passed', 'deploy:passed', 'verify:failed']);
      assert.match(latest(state).stages[1].logs.join('\n'), /pass 2/);
      assert.match(latest(state).failureReason, /exited with code 1/);
      assert.equal(state.pipeline.knownGood.version, '1.0.0');
      assert.equal(testContainers(), '');

      // The build context is the allowlist only.
      assert.deepEqual(docker('run', '--rm', '--entrypoint', 'ls', 'devops-playground-lab/api:1.1.0', '-A', '/app').split('\n').sort(),
        ['package.json', 'server.js', 'tests']);

      const rollback = await browser.run(session.id, 'pipeline.rollback');
      assert.equal(rollback.status, 'succeeded');
      state = await browser.session(session.id);
      assert.equal(state.pipeline.deployed.version, '1.0.0');
      assert.equal(state.pipeline.deployed.status, 'verified');
    });
  });

  it('cancels during tests without touching the service and refuses duplicate runs', async () => {
    const browser = await createBrowser().connect();
    await withSession(browser, 'free-exploration', async (session) => {
      const [before] = ownedContainers(session.id, { role: 'workload' });
      const body = { type: 'pipeline.run', generation: 1, parameters: { releaseId: 'api-1-0-1' } };
      assert.equal((await browser.request('POST', `/api/sessions/${session.id}/operations`, { body, key: 'run-cancel-1' })).status, 202);
      const duplicate = await browser.request('POST', `/api/sessions/${session.id}/operations`, { body, key: 'run-cancel-2' });
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.body.error.code, 'PIPELINE_BUSY');

      for (let attempt = 0; attempt < 120; attempt += 1) {
        const state = await browser.session(session.id);
        if (latest(state)?.stages.find((stage) => stage.id === 'test').status === 'running') {
          break;
        }
        await sleep(250);
      }
      const cancel = await browser.run(session.id, 'pipeline.cancel');
      assert.equal(cancel.status, 'succeeded');
      const state = await browser.session(session.id);
      assert.equal(latest(state).status, 'cancelled');
      assert.equal(latest(state).stages.find((stage) => stage.id === 'deploy').status, 'skipped');
      const [after] = ownedContainers(session.id, { role: 'workload' });
      assert.equal(after.id, before.id);
      assert.equal(docker('inspect', after.id, '--format', '{{.Config.Image}} {{.State.Running}}'), 'devops-playground-lab/api:1.0.0 true');
      for (let attempt = 0; attempt < 40 && testContainers(); attempt += 1) {
        await sleep(250);
      }
      assert.equal(testContainers(), '');
    });
  });
});
