import { afterEach, describe, expect, it, vi } from 'vitest';
import { BLOB_API_VERSION, createBlobAdapter, translateBlobError } from '../src/storage/blob-adapter.js';
import { createEmulatorContainer, EMULATORS } from '../src/docker/emulators.js';

const AMBIENT = {
  AZURE_STORAGE_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountName=realaccount;EndpointSuffix=core.windows.net',
  AZURE_STORAGE_ACCOUNT: 'realaccount',
  AZURE_CLIENT_ID: 'ambient-client',
  AZURE_TENANT_ID: 'ambient-tenant',
};

describe('Azure Blob adapter configuration', () => {
  afterEach(() => {
    for (const name of Object.keys(AMBIENT)) {
      delete process.env[name];
    }
  });

  it('refuses a non-emulator endpoint before any client exists', () => {
    const clientFactory = vi.fn();
    for (const endpoint of ['https://realaccount.blob.core.windows.net', 'http://storage:10000/otheraccount', 'http://storage:5000']) {
      expect(() => createBlobAdapter({ endpoint, clientFactory })).toThrow(expect.objectContaining({ code: 'ENDPOINT_NOT_ALLOWED' }));
    }
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('uses the explicit emulator account whatever the environment says', () => {
    Object.assign(process.env, AMBIENT);
    const adapter = createBlobAdapter();
    expect(adapter.client.url).toBe('http://storage:10000/devstoreaccount1');
    expect(adapter.client.accountName).toBe('devstoreaccount1');
    expect(adapter.client.credential.constructor.name).toBe('StorageSharedKeyCredential');
  });

  it('translates Blob failures into provider errors or a retryable outage', () => {
    expect(translateBlobError({ code: 'ContainerNotFound' }, { namespace: 'lab-reports' })).toMatchObject({ code: 'CONTAINER_NOT_FOUND' });
    expect(translateBlobError({ code: 'BlobNotFound' }, { namespace: 'lab-reports', key: 'a.txt' }).message).toMatch(/^BlobNotFound:/);
    expect(translateBlobError({ details: { errorCode: 'ContainerAlreadyExists' } }, { namespace: 'x-y' })).toMatchObject({ code: 'CONTAINER_ALREADY_EXISTS' });
    expect(translateBlobError({ code: 'REQUEST_SEND_ERROR' })).toMatchObject({ code: 'STORAGE_BACKEND_UNAVAILABLE', retryable: true });
    expect(translateBlobError({ code: 'InternalError', message: 'stack trace here' }).message).not.toContain('stack trace');
  });

  it('selects the tested API version explicitly', () => {
    const clientFactory = vi.fn(() => ({}));
    createBlobAdapter({ clientFactory });
    expect(clientFactory).toHaveBeenCalledWith(
      'http://storage:10000/devstoreaccount1',
      expect.anything(),
      expect.objectContaining({ serviceVersion: BLOB_API_VERSION }),
    );
  });

  it('bounds downloads even if a blob grows after its properties were read', async () => {
    const blob = {
      getProperties: vi.fn().mockResolvedValue({ contentLength: 2, etag: 'version-1', lastModified: new Date('2026-11-04T10:00:00Z') }),
      downloadToBuffer: vi.fn().mockResolvedValue(Buffer.alloc(65537)),
    };
    const adapter = createBlobAdapter({
      clientFactory: () => ({ getContainerClient: () => ({ getBlobClient: () => blob }) }),
    });
    await expect(adapter.readObject('lab-reports', 'notes.txt')).rejects.toMatchObject({ code: 'OBJECT_TOO_LARGE' });
    expect(blob.downloadToBuffer).toHaveBeenCalledWith(0, 2, expect.objectContaining({ conditions: { ifMatch: 'version-1' } }));
  });

  it('runs Azurite as a Blob-only, in-memory, unprivileged session emulator', async () => {
    const spec = await createEmulatorContainer({ createContainer: async (value) => value }, {
      installationId: 'install-1',
      session: { id: 'session-abc', generation: 1, labId: 'blob-provision', fixtureId: 'blob-unprovisioned' },
      emulator: EMULATORS['azure-blob'],
      network: 'dpg-sessionabc-g1',
    });
    expect(spec.Image).toMatch(/^mcr\.microsoft\.com\/azure-storage\/azurite:3\.37\.0@sha256:[0-9a-f]{64}$/);
    expect(spec.Cmd).toEqual(expect.arrayContaining(['azurite-blob', '--inMemoryPersistence', '--disableTelemetry']));
    expect(spec.Cmd).not.toContain('--skipApiVersionCheck');
    expect(spec.Cmd).not.toContain('--loose');
    expect(spec.User).toBe('65534:65534');
    expect(spec.HostConfig).toMatchObject({ ReadonlyRootfs: true, CapDrop: ['ALL'], PortBindings: {}, Privileged: false });
  });
});
