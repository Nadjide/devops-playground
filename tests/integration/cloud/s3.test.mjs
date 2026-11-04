// Real local S3 integration: the packaged portal drives a session-owned Moto
// emulator and the storage-capable workload. Requires a running Docker daemon.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowser, docker, launcher, ownedContainers, withSession } from '../local/client.mjs';

const MOTO = 'motoserver/moto:5.2.5@sha256:59a1965d845249b04def37a0e2565f9cc6c44543cb89b68e90f28f344b3b0d1a';
const objective = (session, id) => session.mission.objectives.find((item) => item.id === id).status;
const emulatorOf = (sessionId) => ownedContainers(sessionId, { role: 'emulator' })[0];
const workloadOf = (sessionId) => ownedContainers(sessionId, { role: 'workload' })[0];

describe('local S3 storage labs', { timeout: 20 * 60_000 }, () => {
  let browser;

  before(async () => {
    launcher('down');
    launcher('local');
    browser = await createBrowser().connect();
  });

  after(() => {
    launcher('down');
  });

  it('runs core labs without pulling or starting the emulator', async () => {
    await withSession(browser, 'stopped-container', async (session) => {
      assert.equal(ownedContainers(session.id, { role: 'emulator' }).length, 0);
    });
  });

  it('completes M04 against Moto with the workload writing and reading its own payload', async () => {
    await withSession(browser, 'storage-provision', async (session) => {
      assert.equal(session.mode, 'local');
      assert.equal(session.storage.provider, 'aws-s3');
      assert.deepEqual(session.storage.namespaces.map((item) => [item.name, item.owned, item.source]), [['shared-audit-logs', false, 'emulator']]);

      const emulator = emulatorOf(session.id);
      assert.equal(emulator.state, 'running');
      assert.equal(docker('inspect', emulator.id, '--format', '{{.Config.Image}} {{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Memory}} {{len .HostConfig.PortBindings}} {{.HostConfig.Privileged}}'),
        `${MOTO} 65534:65534 true 268435456 0 false`);
      assert.match(docker('inspect', emulator.id, '--format', '{{json .HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}}'), /\["ALL"\] \["no-new-privileges:true"\]/);
      const network = docker('inspect', emulator.id, '--format', '{{range $name, $value := .NetworkSettings.Networks}}{{$name}}{{end}}');
      assert.equal(docker('network', 'inspect', network, '--format', '{{.Internal}}'), 'true');

      const env = docker('inspect', workloadOf(session.id).id, '--format', '{{json .Config.Env}}');
      assert.match(env, /STORAGE_ENDPOINT=http:\/\/storage:5000/);
      assert.match(env, /AWS_ACCESS_KEY_ID=testing/);

      const missing = await browser.run(session.id, 'storage.roundtrip.verify', { serviceId: 'api' });
      assert.equal(missing.status, 'failed');
      assert.match(missing.error.message, /returned 503: NoSuchBucket/);

      assert.equal((await browser.run(session.id, 'storage.namespace.create', { namespace: 'Bad_Name' })).error.code, 'INVALID_BUCKET_NAME');
      assert.equal((await browser.run(session.id, 'storage.namespace.create', { namespace: 'shared-audit-logs' })).error.code, 'BUCKET_ALREADY_EXISTS');
      assert.equal((await browser.run(session.id, 'storage.namespace.create', { namespace: 'lab-reports' })).status, 'succeeded');
      assert.equal((await browser.run(session.id, 'storage.namespace.create', { namespace: 'lab-reports' })).error.code, 'BUCKET_ALREADY_OWNED_BY_YOU');

      const content = 'Quarterly report\n'.repeat(4000).slice(0, 60_000);
      const put = await browser.run(session.id, 'storage.object.put', { namespace: 'lab-reports', key: 'notes.txt', content });
      assert.equal(put.status, 'succeeded');
      const get = await browser.run(session.id, 'storage.object.get', { namespace: 'lab-reports', key: 'notes.txt' });
      assert.equal(get.result.sha256, put.result.sha256);
      assert.equal(get.result.bytes, 60_000);
      assert.equal(get.result.truncated, true);
      assert.equal((await browser.run(session.id, 'storage.object.get', { namespace: 'lab-reports', key: 'nope.txt' })).error.code, 'NO_SUCH_KEY');

      let current = await browser.session(session.id);
      assert.equal(objective(current, 'create-namespace'), 'satisfied');
      assert.equal(objective(current, 'write-read'), 'satisfied');
      assert.equal(objective(current, 'verify-roundtrip'), 'pending');

      const check = await browser.run(session.id, 'storage.roundtrip.verify', { serviceId: 'api' });
      assert.equal(check.status, 'succeeded');
      assert.equal(check.result.statusCode, 200);
      current = await browser.session(session.id);
      assert.equal(current.mission.status, 'completed');
      const record = current.storage.roundTrips.at(-1);
      assert.equal(record.source, 'probe');
      assert.equal(record.observedSha256, record.expectedSha256);
      assert.ok(current.storage.objects.some((item) => item.key === 'storage-check.txt' && item.writer === 'workload' && item.source === 'emulator'));
      assert.match(docker('logs', workloadOf(session.id).id), /Storage check passed: wrote and read back s3:\/\/lab-reports\/storage-check\.txt/);

      // The emulator really holds the workload's object.
      const listed = await browser.run(session.id, 'storage.object.list', { namespace: 'lab-reports' });
      assert.deepEqual(listed.result.objects.map((item) => item.key).sort(), ['notes.txt', 'storage-check.txt']);
    });
  });

  it('refuses external endpoints, foreign buckets, and oversized bodies before any change', async () => {
    await withSession(browser, 'storage-config', async (session) => {
      const workload = workloadOf(session.id);
      for (const endpoint of ['https://s3.amazonaws.com', 'http://169.254.169.254', 'http://storage:5001']) {
        const result = await browser.run(session.id, 'storage.configure', { serviceId: 'api', namespace: 'lab-reports', endpoint });
        assert.equal(result.error.code, 'ENDPOINT_NOT_ALLOWED');
      }
      assert.equal((await browser.run(session.id, 'storage.configure', { serviceId: 'api', namespace: 'shared-audit-logs' })).error.code, 'NAMESPACE_NOT_OWNED');
      for (const [type, parameters] of [
        ['storage.object.put', { namespace: 'shared-audit-logs', key: 'x.txt', content: 'x' }],
        ['storage.object.delete', { namespace: 'shared-audit-logs', key: 'retention-policy.txt' }],
        ['storage.namespace.delete', { namespace: 'shared-audit-logs' }],
      ]) {
        assert.equal((await browser.run(session.id, type, parameters)).error.code, 'NAMESPACE_NOT_OWNED');
      }
      // The workload was never replaced by a refused request.
      assert.equal(workloadOf(session.id).id, workload.id);
      const oversized = await browser.run(session.id, 'storage.object.put', { namespace: 'lab-reports', key: 'big.txt', content: 'x'.repeat(70 * 1024) });
      assert.equal(oversized.rejected.status, 400);
      assert.equal((await browser.run(session.id, 'storage.namespace.delete', { namespace: 'lab-reports' })).error.code, 'BUCKET_NOT_EMPTY');
    });
  });

  it('repairs M05 by reconfiguring the real workload and verifying a fresh round trip', async () => {
    await withSession(browser, 'storage-config', async (session) => {
      assert.match(docker('logs', workloadOf(session.id).id), /Storage target: aws-s3 bucket lab-report at http:\/\/storage:5000/);
      await browser.run(session.id, 'container.logs', { serviceId: 'api', tail: 50 });
      const before = workloadOf(session.id).id;
      const configured = await browser.run(session.id, 'storage.configure', { serviceId: 'api', namespace: 'lab-reports' });
      assert.equal(configured.status, 'succeeded');
      assert.equal(configured.result.replaced, true);
      const after = workloadOf(session.id);
      assert.notEqual(after.id, before);
      assert.match(docker('inspect', after.id, '--format', '{{json .Config.Env}}'), /STORAGE_NAMESPACE=lab-reports"/);
      assert.equal((await browser.run(session.id, 'storage.roundtrip.verify', { serviceId: 'api' })).status, 'succeeded');
      assert.equal((await browser.session(session.id)).mission.status, 'completed');
    });
  });

  it('reports an emulator outage as retryable, keeps the session, and recovers through reset', async () => {
    await withSession(browser, 'storage-provision', async (session) => {
      docker('stop', '-t', '1', emulatorOf(session.id).id);
      const failed = await browser.run(session.id, 'storage.namespace.list');
      assert.equal(failed.status, 'failed');
      assert.equal(failed.error.code, 'STORAGE_BACKEND_UNAVAILABLE');
      assert.equal(failed.error.retryable, true);
      assert.equal((await browser.session(session.id)).status, 'active');

      // A restarted Moto has lost its in-memory data; listing reports what is really there.
      docker('start', emulatorOf(session.id).id);
      let listed;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        listed = await browser.run(session.id, 'storage.namespace.list');
        if (listed.status === 'succeeded') {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      assert.equal(listed.status, 'succeeded');
      assert.deepEqual(listed.result.namespaces, []);
      assert.deepEqual((await browser.session(session.id)).storage.namespaces, []);

      const reset = await browser.run(session.id, 'session.reset');
      assert.equal(reset.status, 'succeeded');
      const current = await browser.session(session.id);
      assert.equal(current.generation, 2);
      assert.deepEqual(current.storage.namespaces.map((item) => item.name), ['shared-audit-logs']);
      assert.equal(ownedContainers(session.id, { role: 'emulator' }).filter((item) => item.name.includes('-g1-')).length, 0);
    });
  });

  it('removes the emulator and its data when the session ends', async () => {
    const session = await browser.createSession('storage-provision');
    await browser.run(session.id, 'storage.namespace.create', { namespace: 'lab-reports' });
    assert.equal(ownedContainers(session.id).length, 2);
    assert.equal((await browser.run(session.id, 'session.end')).status, 'succeeded');
    assert.equal(ownedContainers(session.id).length, 0);
    assert.equal(docker('network', 'ls', '--filter', `label=devops-playground.session=${session.id}`, '--format', '{{.Name}}'), '');
  });
});
