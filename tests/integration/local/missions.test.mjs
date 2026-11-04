// Real local Docker integration: drives the packaged portal like a browser and
// correlates its state with `docker inspect`. Requires a running Docker daemon.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowser, docker, launcher, ownedContainers } from './client.mjs';

const objective = (session, id) => session.mission.objectives.find((item) => item.id === id).status;

describe('local Docker missions', { timeout: 15 * 60_000 }, () => {
  before(() => {
    launcher('down');
    launcher('local');
  });

  after(() => {
    launcher('down');
    // Remove only the foreign stand-in this suite created, even after a failure.
    const leftovers = docker('ps', '-aq', '--filter', 'label=devops-playground.integration-fixture=foreign');
    if (leftovers) {
      docker('rm', '-f', ...leftovers.split('\n'));
    }
  });

  it('completes M01 against a real container and cleans up only owned resources', async () => {
    const browser = await createBrowser().connect();
    const session = await browser.createSession('stopped-container');
    const [container] = ownedContainers(session.id);
    assert.equal(container.state, 'exited');
    assert.match(docker('logs', container.id), /HTTP server closed, exiting with code 0/);
    assert.equal(docker('inspect', container.id, '--format', '{{.State.ExitCode}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{.Config.User}}'),
      '0 true 268435456 128 node');
    assert.equal(docker('inspect', container.id, '--format', '{{json .HostConfig.Binds}} {{.HostConfig.Privileged}} {{json .HostConfig.PortBindings}}'),
      'null false {}');

    // A foreign resource carrying our session label but another installation must survive.
    const foreign = docker('run', '-d', '--label', 'devops-playground.integration-fixture=foreign',
      '--label', 'devops-playground.managed=true', '--label', 'devops-playground.installation=foreign-install',
      '--label', `devops-playground.session=${session.id}`, '--label', 'devops-playground.generation=1', 'node:22-alpine', 'sleep', '600');

    const other = await createBrowser().connect();
    assert.equal((await other.request('GET', `/api/sessions/${session.id}`)).status, 404);

    const probeBefore = await browser.run(session.id, 'health.probe', { serviceId: 'api' });
    assert.equal(probeBefore.status, 'failed');
    assert.match(probeBefore.error.message, /is not running \(container exited\)/);

    assert.equal((await browser.run(session.id, 'container.logs', { serviceId: 'api', tail: 50 })).status, 'succeeded');
    const start = await browser.run(session.id, 'container.start', { serviceId: 'api' });
    assert.equal(start.status, 'succeeded');
    assert.equal(docker('inspect', container.id, '--format', '{{.State.Running}}'), 'true');

    const health = await browser.run(session.id, 'health.probe', { serviceId: 'api' });
    assert.equal(health.status, 'succeeded');
    assert.equal(health.result.statusCode, 200);
    assert.equal(health.result.body.status, 'ok');
    assert.equal(health.result.body.service, 'devops-playground');
    const version = await browser.run(session.id, 'version.probe', { serviceId: 'api' });
    assert.equal(version.result.body.version, '1.0.0');

    let state = await browser.session(session.id);
    assert.equal(state.mission.status, 'completed');
    assert.equal(state.probes.at(-1).source, 'probe');
    assert.equal(state.resources[0].observed.source, 'docker');
    assert.ok(state.logs.entries.some((entry) => entry.message === 'DevOps Playground API 1.0.0 listening on port 3000'));

    const rejected = await browser.request('POST', `/api/sessions/${session.id}/operations`, {
      body: { type: 'health.probe', generation: 1, parameters: { serviceId: 'api', url: 'http://169.254.169.254/' } }, key: 'ssrf-1',
    });
    assert.equal(rejected.status, 400);

    const end = await browser.run(session.id, 'session.end');
    assert.equal(end.status, 'succeeded');
    state = await browser.session(session.id);
    assert.equal(state.status, 'ended');
    const remaining = ownedContainers(session.id);
    assert.deepEqual(remaining.map((item) => item.installation), ['foreign-install']);
    assert.equal(docker('network', 'ls', '--filter', `label=devops-playground.session=${session.id}`, '-q'), '');
    docker('rm', '-f', foreign);
  });

  it('completes M02 by replacing the workload with the approved port', async () => {
    const browser = await createBrowser().connect();
    const session = await browser.createSession('wrong-port');
    const [before] = ownedContainers(session.id);
    assert.equal(before.state, 'running');
    assert.match(docker('inspect', before.id, '--format', '{{json .Config.Env}}'), /APP_PORT=3001/);

    const refused = await browser.run(session.id, 'health.probe', { serviceId: 'api' });
    assert.equal(refused.status, 'failed');
    assert.match(refused.error.message, /ECONNREFUSED/);
    assert.equal((await browser.run(session.id, 'container.inspect', { serviceId: 'api' })).status, 'succeeded');

    const configure = await browser.run(session.id, 'service.configure', { serviceId: 'api', appPort: 3000 });
    assert.equal(configure.status, 'succeeded');
    assert.equal(configure.result.replaced, true);
    const [after] = ownedContainers(session.id);
    assert.notEqual(after.id, before.id);
    assert.match(docker('inspect', after.id, '--format', '{{json .Config.Env}}'), /APP_PORT=3000/);

    const health = await browser.run(session.id, 'health.probe', { serviceId: 'api' });
    assert.equal(health.status, 'succeeded');
    const state = await browser.session(session.id);
    assert.equal(objective(state, 'apply-port'), 'satisfied');
    assert.equal(state.mission.status, 'completed');

    assert.equal((await browser.run(session.id, 'session.end')).status, 'succeeded');
    assert.deepEqual(ownedContainers(session.id), []);
  });
});
