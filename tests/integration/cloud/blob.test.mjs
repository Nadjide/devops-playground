// Real local Azure Blob integration: a session-owned Azurite emulator, the
// storage workload, provider switching, and controller restart recovery.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowser, docker, launcher, ownedContainers, withSession } from '../local/client.mjs';

const AZURITE = 'mcr.microsoft.com/azure-storage/azurite:3.37.0@sha256:830430c1da1a2d537e08f3e6764dd1f5ae00cf0346bcaf625b968ec3f0971fd5';
const CONTROL = 'devops-playground-control-1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const objective = (session, id) => session.mission.objectives.find((item) => item.id === id).status;
const emulatorOf = (sessionId) => ownedContainers(sessionId, { role: 'emulator' })[0];
const workloadOf = (sessionId) => ownedContainers(sessionId, { role: 'workload' })[0];

async function waitHealthy(name) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (docker('inspect', name, '--format', '{{.State.Health.Status}}') === 'healthy') {
      return;
    }
    await sleep(500);
  }
  throw new Error(`${name} did not become healthy`);
}

describe('local Azure Blob storage labs', { timeout: 20 * 60_000 }, () => {
  let browser;

  before(async () => {
    launcher('down');
    launcher('local');
    browser = await createBrowser().connect();
  });

  after(() => {
    launcher('down');
    const leftovers = docker('ps', '-aq', '--filter', 'label=devops-playground.integration-fixture=foreign-emulator');
    if (leftovers) {
      docker('rm', '-f', ...leftovers.split('\n'));
    }
  });

  it('completes M04 against Azurite with container and blob semantics', async () => {
    await withSession(browser, 'blob-provision', async (session) => {
      assert.equal(session.storage.provider, 'azure-blob');
      assert.equal(session.storage.endpoint, 'http://storage:10000/devstoreaccount1');
      const emulator = emulatorOf(session.id);
      assert.equal(docker('inspect', emulator.id, '--format', '{{.Config.Image}} {{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{len .HostConfig.PortBindings}}'),
        `${AZURITE} 65534:65534 true 0`);
      assert.match(docker('inspect', emulator.id, '--format', '{{json .Config.Cmd}}'), /"--inMemoryPersistence"/);

      const missing = await browser.run(session.id, 'storage.roundtrip.verify', { serviceId: 'api' });
      assert.match(missing.error.message, /returned 503: ContainerNotFound/);
      assert.equal((await browser.run(session.id, 'storage.namespace.create', { namespace: 'lab.reports' })).error.code, 'INVALID_RESOURCE_NAME');
      assert.equal((await browser.run(session.id, 'storage.namespace.create', { namespace: 'lab-reports' })).status, 'succeeded');
      assert.equal((await browser.run(session.id, 'storage.namespace.create', { namespace: 'lab-reports' })).error.code, 'CONTAINER_ALREADY_EXISTS');

      const put = await browser.run(session.id, 'storage.object.put', { namespace: 'lab-reports', key: 'notes.txt', content: 'Blob report' });
      const get = await browser.run(session.id, 'storage.object.get', { namespace: 'lab-reports', key: 'notes.txt' });
      assert.equal(get.result.sha256, put.result.sha256);
      assert.equal(get.result.content, 'Blob report');
      // Azure refuses to delete a missing blob, unlike S3.
      assert.equal((await browser.run(session.id, 'storage.object.delete', { namespace: 'lab-reports', key: 'other.txt' })).error.code, 'BLOB_NOT_FOUND');

      assert.equal((await browser.run(session.id, 'storage.roundtrip.verify', { serviceId: 'api' })).status, 'succeeded');
      const current = await browser.session(session.id);
      assert.equal(current.mission.status, 'completed');
      assert.equal(objective(current, 'verify-roundtrip'), 'satisfied');
      assert.match(docker('logs', workloadOf(session.id).id),
        /Storage check passed: wrote and read back http:\/\/storage:10000\/devstoreaccount1\/lab-reports\/storage-check\.txt/);

      // Azure deletes a container together with its blobs.
      const removed = await browser.run(session.id, 'storage.namespace.delete', { namespace: 'lab-reports' });
      assert.equal(removed.result.objectsRemoved, 2);
      assert.deepEqual((await browser.session(session.id)).storage.namespaces.map((item) => item.name), ['shared-audit-logs']);
    });
  });

  it('repairs M05 against Azurite and refuses foreign containers and other endpoints', async () => {
    await withSession(browser, 'blob-config', async (session) => {
      await browser.run(session.id, 'container.logs', { serviceId: 'api', tail: 50 });
      assert.equal((await browser.run(session.id, 'storage.configure', { serviceId: 'api', namespace: 'lab-reports', endpoint: 'http://storage:5000' })).error.code,
        'ENDPOINT_NOT_ALLOWED');
      assert.equal((await browser.run(session.id, 'storage.configure', { serviceId: 'api', namespace: 'shared-audit-logs' })).error.code, 'NAMESPACE_NOT_OWNED');
      assert.equal((await browser.run(session.id, 'storage.configure', { serviceId: 'api', namespace: 'lab-reports' })).status, 'succeeded');
      assert.equal((await browser.run(session.id, 'storage.roundtrip.verify', { serviceId: 'api' })).status, 'succeeded');
      assert.equal((await browser.session(session.id)).mission.status, 'completed');
    });
  });

  it('switches provider through a new session without leaking emulators or evidence', async () => {
    const s3 = await browser.createSession('storage-provision');
    await browser.run(s3.id, 'storage.namespace.create', { namespace: 'lab-reports' });
    assert.equal(docker('inspect', emulatorOf(s3.id).id, '--format', '{{.Config.Image}}').startsWith('motoserver/moto:5.2.5@'), true);
    // One local session at a time: the S3 session must end before Azure starts.
    assert.equal((await browser.request('POST', '/api/sessions', { body: { labId: 'blob-provision' } })).status, 429);
    assert.equal((await browser.run(s3.id, 'session.end')).status, 'succeeded');
    assert.equal(ownedContainers(s3.id).length, 0);

    await withSession(browser, 'blob-provision', async (blob) => {
      assert.equal(blob.storage.provider, 'azure-blob');
      assert.deepEqual(blob.storage.namespaces.map((item) => item.name), ['shared-audit-logs']);
      assert.ok(blob.mission.objectives.every((item) => item.status === 'pending'));
      assert.equal(docker('ps', '-q', '--filter', 'label=devops-playground.role=emulator', '--filter', `label=devops-playground.session=${s3.id}`), '');
    });
  });

  it('reports an emulator outage and resets to a new clean generation', async () => {
    await withSession(browser, 'blob-provision', async (session) => {
      await browser.run(session.id, 'storage.namespace.create', { namespace: 'lab-reports' });
      const emulator = emulatorOf(session.id);
      docker('stop', '-t', '1', emulator.id);
      const failed = await browser.run(session.id, 'storage.namespace.list');
      assert.equal(failed.status, 'failed');
      assert.equal(failed.error.code, 'STORAGE_BACKEND_UNAVAILABLE');
      assert.equal(failed.error.retryable, true);

      assert.equal((await browser.run(session.id, 'session.reset')).status, 'succeeded');
      const reset = await browser.session(session.id);
      assert.equal(reset.generation, session.generation + 1);
      assert.deepEqual(reset.storage.namespaces.map((item) => item.name), ['shared-audit-logs']);
      assert.ok(reset.mission.objectives.every((item) => item.status === 'pending'));
      assert.notEqual(emulatorOf(session.id).id, emulator.id);
      assert.equal(ownedContainers(session.id).some((item) => item.id === emulator.id), false);
    });
  });

  it('recovers storage from the emulator after a controller crash, keeping foreign resources', async () => {
    let client = browser;
    const session = await client.createSession('blob-provision');
    // A foreign emulator stand-in with this session's label but another installation must survive.
    docker('run', '-d', '--label', 'devops-playground.integration-fixture=foreign-emulator',
      '--label', 'devops-playground.managed=true', '--label', 'devops-playground.installation=foreign-install',
      '--label', `devops-playground.session=${session.id}`, '--label', 'devops-playground.role=emulator', 'node:22-alpine', 'sleep', '600');
    try {
      await client.run(session.id, 'storage.namespace.create', { namespace: 'lab-reports' });
      await client.run(session.id, 'storage.object.put', { namespace: 'lab-reports', key: 'notes.txt', content: 'before the crash' });
      await client.run(session.id, 'storage.roundtrip.verify', { serviceId: 'api' });

      docker('kill', '--signal', 'SIGKILL', CONTROL);
      docker('start', CONTROL);
      await waitHealthy(CONTROL);
      client = await createBrowser().connect();
      const recovered = await client.request('POST', `/api/recovery/${session.id}`, { body: { action: 'recover' } });
      assert.equal(recovered.status, 201);
      const state = recovered.body.session;
      assert.equal(state.storage.provider, 'azure-blob');
      assert.deepEqual(state.storage.namespaces.map((item) => [item.name, item.owned, item.source]).sort(),
        [['lab-reports', true, 'emulator'], ['shared-audit-logs', false, 'emulator']]);
      assert.ok(state.storage.objects.some((item) => item.key === 'notes.txt' && item.source === 'emulator'));
      // Round trips from before the restart are not trusted as evidence.
      assert.deepEqual(state.storage.roundTrips, []);
      assert.equal(state.resources[0].desired.storage.namespace, 'lab-reports');
      assert.equal(objective(state, 'verify-roundtrip'), 'pending');

      assert.equal((await client.run(session.id, 'session.end')).status, 'succeeded');
      assert.equal(ownedContainers(session.id).filter((item) => item.installation !== 'foreign-install').length, 0);
      assert.equal(docker('ps', '-q', '--filter', 'label=devops-playground.integration-fixture=foreign-emulator').length > 0, true);
    } finally {
      const current = await client.session(session.id).catch(() => null);
      if (current && current.status !== 'ended') {
        await client.run(session.id, 'session.end');
      }
      browser = client;
    }
  });
});
