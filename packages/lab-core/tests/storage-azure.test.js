import { describe, expect, it } from 'vitest';
import { commandContext, getStorageProvider, labVariants, parseCommand } from '../src/index.js';
import { startRuntime } from './runtime-helpers.js';

const blob = getStorageProvider('azure-blob');

describe('Azure Blob provider', () => {
  it.each([
    ['lab-reports', null],
    ['reports2026', null],
    ['ab', 'from 3 through 63'],
    ['lab.reports', 'lowercase letters, numbers, and hyphens'],
    ['Lab-Reports', 'lowercase letters, numbers, and hyphens'],
    ['-reports', 'start with a letter or number'],
    ['reports-', 'cannot end with a hyphen'],
    ['lab--reports', 'preceded and followed'],
  ])('validates container name %s', (name, problem) => {
    const result = blob.validateNamespace(name);
    if (problem === null) {
      expect(result).toBeNull();
    } else {
      expect(result).toContain(problem);
    }
  });

  it('keeps Azure semantics where they differ from S3', async () => {
    const { run, valid } = await startRuntime({ labId: 'blob-provision' });
    expect((await run('storage.namespace.create', { namespace: 'lab.reports' })).error.code).toBe('INVALID_RESOURCE_NAME');
    expect((await run('storage.namespace.create', { namespace: 'shared-audit-logs' })).error.code).toBe('CONTAINER_ALREADY_EXISTS');
    await run('storage.namespace.create', { namespace: 'lab-reports' });
    const put = await run('storage.object.put', { namespace: 'lab-reports', key: 'notes.txt', content: 'hello' });
    expect(put.result.uri).toBe('http://storage:10000/devstoreaccount1/lab-reports/notes.txt');
    // Deleting a missing blob is an error in Azure, unlike S3.
    expect((await run('storage.object.delete', { namespace: 'lab-reports', key: 'other.txt' })).error.code).toBe('BLOB_NOT_FOUND');
    expect((await run('storage.object.get', { namespace: 'missing-container', key: 'a.txt' })).error.code).toBe('CONTAINER_NOT_FOUND');
    // Deleting a container deletes its blobs.
    const removed = await run('storage.namespace.delete', { namespace: 'lab-reports' });
    expect(removed.result).toMatchObject({ deleted: true, objectsRemoved: 1 });
    expect(valid().storage.objects.map((object) => object.namespace)).toEqual(['shared-audit-logs']);
  });

  it('completes both Azure missions with the same learning outcomes', async () => {
    const provision = await startRuntime({ labId: 'blob-provision' });
    expect((await provision.run('storage.roundtrip.verify', { serviceId: 'api' })).error.message).toContain('ContainerNotFound');
    await provision.run('storage.namespace.create', { namespace: 'lab-reports' });
    await provision.run('storage.object.put', { namespace: 'lab-reports', key: 'notes.txt', content: 'report' });
    await provision.run('storage.object.get', { namespace: 'lab-reports', key: 'notes.txt' });
    await provision.run('storage.roundtrip.verify', { serviceId: 'api' });
    expect(provision.valid().mission.status).toBe('completed');
    expect(provision.valid().storage.roundTrips.at(-1)).toMatchObject({ ok: true, provider: 'azure-blob', endpoint: blob.endpoint });

    const config = await startRuntime({ labId: 'blob-config' });
    await config.run('container.logs', { serviceId: 'api', tail: 20 });
    const wrongProvider = await config.run('storage.configure', { serviceId: 'api', namespace: 'lab-reports', endpoint: 'http://storage:5000' });
    expect(wrongProvider.error.code).toBe('ENDPOINT_NOT_ALLOWED');
    await config.run('storage.configure', { serviceId: 'api', namespace: 'lab-reports' });
    await config.run('storage.roundtrip.verify', { serviceId: 'api' });
    const { mission } = config.valid();
    expect(mission.status).toBe('completed');
    expect(mission.objectives[1].evidence.explanation).toContain('container lab-reports');
  });

  it('declares one variant group per learning outcome with matching providers', () => {
    expect(labVariants('storage-provision').map((lab) => [lab.id, lab.variant.provider]))
      .toEqual([['storage-provision', 'aws-s3'], ['blob-provision', 'azure-blob']]);
    expect(labVariants('blob-config').map((lab) => lab.id)).toEqual(['storage-config', 'blob-config']);
    expect(labVariants('stopped-container').map((lab) => lab.id)).toEqual(['stopped-container']);
  });

  it('keeps each provider session isolated and identified', async () => {
    const s3Session = await startRuntime({ labId: 'storage-provision' });
    await s3Session.run('storage.namespace.create', { namespace: 'lab-reports' });
    const blobSession = await startRuntime({ labId: 'blob-provision' });
    const { storage, mission } = blobSession.valid();
    expect(storage.provider).toBe('azure-blob');
    expect(storage.namespaces.map((namespace) => namespace.name)).toEqual(['shared-audit-logs']);
    expect(mission.objectives.every((item) => item.evidence === null)).toBe(true);
    // A saved S3 session cannot be restored into the Azure variant.
    await expect(blobSession.runtime.start({ restore: s3Session.valid() })).rejects.toMatchObject({ code: 'CHECKPOINT_MISMATCH' });
  });
});

describe('az storage terminal grammar', () => {
  const context = commandContext({
    fixtureId: 'blob-unprovisioned',
    resources: [{ serviceId: 'api', desired: { expectedProbePort: 3000 } }],
    storage: { provider: 'azure-blob' },
  });

  it.each([
    ['az storage container list', 'storage.namespace.list', {}],
    ['az storage container create -n lab-reports', 'storage.namespace.create', { namespace: 'lab-reports' }],
    ['az storage container create --name=lab-reports', 'storage.namespace.create', { namespace: 'lab-reports' }],
    ['az storage blob list -c lab-reports', 'storage.object.list', { namespace: 'lab-reports' }],
    ['az storage blob download --container-name lab-reports --name notes.txt', 'storage.object.get', { namespace: 'lab-reports', key: 'notes.txt' }],
    ['az storage blob delete -c lab-reports -n notes.txt', 'storage.object.delete', { namespace: 'lab-reports', key: 'notes.txt' }],
  ])('maps %s to %s', (input, type, parameters) => {
    expect(parseCommand(input, context)).toMatchObject({ kind: 'operation', request: { type, parameters } });
  });

  it.each([
    ['az storage container delete -n lab-reports', 'Cloud panel'],
    ['az storage blob upload -c lab-reports -n a.txt', 'no file system'],
    ['az storage container list --connection-string UseDevelopmentStorage=true', 'session emulator'],
    ['az storage blob list -c lab-reports --account-key abc', 'session emulator'],
    ['az storage blob download -c lab-reports -n dir/a.txt', 'slashes'],
    ['az vm list', 'Only az storage'],
    ['aws s3 ls', 'no AWS S3'],
  ])('rejects %s', (input, message) => {
    expect(parseCommand(input, context)).toMatchObject({ kind: 'error', message: expect.stringContaining(message) });
  });
});
