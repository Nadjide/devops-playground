import { afterEach, describe, expect, it, vi } from 'vitest';
import { createS3Adapter, translateS3Error } from '../src/storage/s3-adapter.js';
import { createStorageDriver, workloadStorageEnv } from '../src/storage/storage-driver.js';
import { createEmulatorContainer, EMULATORS, ensureEmulatorImage } from '../src/docker/emulators.js';

const AMBIENT = {
  AWS_ACCESS_KEY_ID: 'ambient-test-access-id',
  AWS_SECRET_ACCESS_KEY: 'ambient-secret-that-must-not-be-used',
  AWS_SESSION_TOKEN: 'ambient-session-token',
  AWS_PROFILE: 'production',
  AWS_REGION: 'eu-west-3',
  AWS_ENDPOINT_URL: 'https://s3.amazonaws.com',
  AWS_ENDPOINT_URL_S3: 'https://s3.eu-west-3.amazonaws.com',
};

describe('S3 adapter configuration', () => {
  afterEach(() => {
    for (const name of Object.keys(AMBIENT)) {
      delete process.env[name];
    }
  });

  it('refuses a non-emulator endpoint before any client exists', () => {
    const clientFactory = vi.fn();
    for (const endpoint of ['https://s3.amazonaws.com', 'http://169.254.169.254', 'http://storage:5001']) {
      expect(() => createS3Adapter({ endpoint, clientFactory })).toThrow(expect.objectContaining({ code: 'ENDPOINT_NOT_ALLOWED' }));
    }
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('ignores ambient AWS credentials, profiles, regions, and endpoints', async () => {
    Object.assign(process.env, AMBIENT);
    const adapter = createS3Adapter();
    try {
      const credentials = await adapter.client.config.credentials();
      expect(credentials).toMatchObject({ accessKeyId: 'testing', secretAccessKey: 'testing' });
      expect(credentials.sessionToken).toBeUndefined();
      expect(await adapter.client.config.region()).toBe('us-east-1');
      const endpoint = await adapter.client.config.endpoint();
      expect(`${endpoint.protocol}//${endpoint.hostname}:${endpoint.port}`).toBe('http://storage:5000');
      expect(adapter.client.config.forcePathStyle).toBe(true);
    } finally {
      adapter.destroy();
    }
  });

  it('translates S3 failures into provider errors or a retryable outage', () => {
    expect(translateS3Error({ name: 'NoSuchBucket' }, { namespace: 'lab-reports' })).toMatchObject({ code: 'NO_SUCH_BUCKET', retryable: false });
    expect(translateS3Error({ name: 'BucketNotEmpty' }, { namespace: 'lab-reports' }).message).toMatch(/^BucketNotEmpty:/);
    expect(translateS3Error({ name: 'NoSuchKey' }, { namespace: 'a-b', key: 'k.txt' }).message).toContain('s3://a-b/k.txt');
    expect(translateS3Error({ name: 'Error', cause: { code: 'ECONNREFUSED' } })).toMatchObject({ code: 'STORAGE_BACKEND_UNAVAILABLE', retryable: true });
    expect(translateS3Error({ name: 'TimeoutError' })).toMatchObject({ code: 'STORAGE_BACKEND_UNAVAILABLE' });
    expect(translateS3Error({ name: 'InternalError', message: 'secret details' }).message).not.toContain('secret details');
  });

  it('gives the workload only the emulator target and test-only settings', () => {
    const env = workloadStorageEnv('aws-s3', { namespace: 'lab-reports', endpoint: 'http://storage:5000' });
    expect(env).toEqual([
      'STORAGE_PROVIDER=aws-s3', 'STORAGE_ENDPOINT=http://storage:5000', 'STORAGE_NAMESPACE=lab-reports',
      'AWS_ACCESS_KEY_ID=testing', 'AWS_SECRET_ACCESS_KEY=testing', 'AWS_REGION=us-east-1',
    ]);
    const blob = workloadStorageEnv('azure-blob', { namespace: 'lab-reports', endpoint: 'http://storage:10000/devstoreaccount1' });
    expect(blob.slice(0, 4)).toEqual([
      'STORAGE_PROVIDER=azure-blob', 'STORAGE_ENDPOINT=http://storage:10000/devstoreaccount1', 'STORAGE_NAMESPACE=lab-reports',
      'AZURE_STORAGE_ACCOUNT=devstoreaccount1',
    ]);
    expect(blob.at(-1)).toBe('AZURE_STORAGE_API_VERSION=2026-06-06');
    expect(() => workloadStorageEnv('gcs', { namespace: 'x', endpoint: 'y' })).toThrow(expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }));
  });
});

describe('session emulator container', () => {
  it('is pinned, internal, unpublished, and constrained', async () => {
    const createContainer = vi.fn(async (spec) => spec);
    const spec = await createEmulatorContainer({ createContainer }, {
      installationId: 'install-1',
      session: { id: 'session-abc', generation: 2, labId: 'storage-provision', fixtureId: 's3-unprovisioned' },
      emulator: EMULATORS['aws-s3'],
      network: 'dpg-sessionabc-g2',
    });
    expect(spec.Image).toMatch(/^motoserver\/moto:5\.2\.5@sha256:[0-9a-f]{64}$/);
    expect(spec.User).toBe('65534:65534');
    expect(spec.Labels).toMatchObject({
      'devops-playground.managed': 'true', 'devops-playground.installation': 'install-1', 'devops-playground.session': 'session-abc',
      'devops-playground.generation': '2', 'devops-playground.role': 'emulator', 'devops-playground.service': 'storage',
    });
    expect(spec.HostConfig).toMatchObject({
      NetworkMode: 'dpg-sessionabc-g2', ReadonlyRootfs: true, CapDrop: ['ALL'], Privileged: false, PortBindings: {},
      SecurityOpt: ['no-new-privileges:true'], Memory: 256 * 1024 * 1024, PidsLimit: 128,
    });
    expect(spec.HostConfig.Binds).toBeUndefined();
    expect(spec.NetworkingConfig.EndpointsConfig['dpg-sessionabc-g2'].Aliases).toEqual(['storage']);
  });

  it('pulls the pinned image only when it is missing and reports pull failures as retryable', async () => {
    const present = { getImage: () => ({ inspect: async () => ({}) }), pull: vi.fn() };
    expect(await ensureEmulatorImage(present, EMULATORS['aws-s3'])).toEqual({ pulled: false });
    expect(present.pull).not.toHaveBeenCalled();

    const offline = {
      getImage: () => ({ inspect: async () => { throw Object.assign(new Error('missing'), { statusCode: 404 }); } }),
      pull: vi.fn(async () => { throw new Error('network down'); }),
    };
    await expect(ensureEmulatorImage(offline, EMULATORS['aws-s3'])).rejects.toMatchObject({ code: 'EMULATOR_PULL_FAILED', retryable: true });
    expect(offline.pull).toHaveBeenCalledWith(EMULATORS['aws-s3'].image);
  });
});

describe('storage driver rules', () => {
  const sha = 'a'.repeat(64);
  const storage = {
    provider: 'aws-s3',
    endpoint: 'http://storage:5000',
    namespaces: [
      { name: 'lab-reports', owned: true, createdAt: null, source: 'emulator', observedAt: '2026-11-04T10:00:00.000Z' },
      { name: 'shared-audit-logs', owned: false, createdAt: null, source: 'emulator', observedAt: '2026-11-04T10:00:00.000Z' },
    ],
    objects: [],
    roundTrips: [],
  };

  function fakeAdapter(overrides = {}) {
    return {
      listNamespaces: async () => [{ name: 'lab-reports', owned: true, createdAt: null }, { name: 'shared-audit-logs', owned: false, createdAt: null }],
      ownerOf: async (name) => (name === 'lab-reports' ? 'lab' : 'platform-team'),
      createNamespace: vi.fn(),
      putObject: vi.fn(),
      destroy: () => {},
      ...overrides,
    };
  }

  function driverWith(adapter) {
    return createStorageDriver({ docker: {}, installationId: 'install-1', adapters: { 'aws-s3': () => adapter } });
  }

  const run = (driver, type, parameters) => driver.execute({
    session: { storage }, operation: { type, parameters }, out: { emit: vi.fn() },
  });

  it('keeps S3 errors for existing buckets consistent and checks names first', async () => {
    const adapter = fakeAdapter();
    const driver = driverWith(adapter);
    await expect(run(driver, 'storage.namespace.create', { namespace: 'lab-reports' })).rejects.toMatchObject({ code: 'BUCKET_ALREADY_OWNED_BY_YOU' });
    await expect(run(driver, 'storage.namespace.create', { namespace: 'shared-audit-logs' })).rejects.toMatchObject({ code: 'BUCKET_ALREADY_EXISTS' });
    await expect(run(driver, 'storage.namespace.create', { namespace: 'Bad_Name' })).rejects.toMatchObject({ code: 'INVALID_BUCKET_NAME' });
    expect(adapter.createNamespace).not.toHaveBeenCalled();
  });

  it('refuses writes to namespaces the lab does not own', async () => {
    const adapter = fakeAdapter();
    await expect(run(driverWith(adapter), 'storage.object.put', { namespace: 'shared-audit-logs', key: 'a.txt', content: 'x' }))
      .rejects.toMatchObject({ code: 'NAMESPACE_NOT_OWNED' });
    expect(adapter.putObject).not.toHaveBeenCalled();
  });

  it('accepts only storage-check responses that match the contract', () => {
    const driver = driverWith(fakeAdapter());
    const body = {
      ok: true, provider: 'aws-s3', endpoint: 'http://storage:5000', namespace: 'lab-reports', key: 'storage-check.txt',
      bytes: 80, expectedSha256: sha, observedSha256: sha, error: null,
    };
    expect(driver.roundTripFrom('api', { statusCode: 200, body, durationMs: 12 })).toMatchObject({ ok: true, statusCode: 200 });
    expect(driver.roundTripFrom('api', { statusCode: 503, body: { ...body, ok: false, observedSha256: null, error: 'NoSuchBucket: x' }, durationMs: 3 }))
      .toMatchObject({ ok: false, error: 'NoSuchBucket: x' });
    expect(() => driver.roundTripFrom('api', { statusCode: 200, body: { ...body, observedSha256: 'b'.repeat(64) }, durationMs: 1 }))
      .toThrow(expect.objectContaining({ code: 'WORKLOAD_RESPONSE_INVALID' }));
    expect(() => driver.roundTripFrom('api', { statusCode: 200, body: { ok: true }, durationMs: 1 }))
      .toThrow(expect.objectContaining({ code: 'WORKLOAD_RESPONSE_INVALID' }));
  });

  it('refuses unapproved workload endpoints before reading the emulator', async () => {
    const adapter = fakeAdapter({ listNamespaces: vi.fn() });
    const driver = driverWith(adapter);
    await expect(driver.validateTarget({
      storage, parameters: { serviceId: 'api', namespace: 'lab-reports', endpoint: 'https://s3.amazonaws.com' },
      current: { namespace: 'lab-report', endpoint: 'http://storage:5000' },
    })).rejects.toMatchObject({ code: 'ENDPOINT_NOT_ALLOWED' });
    expect(adapter.listNamespaces).not.toHaveBeenCalled();
  });
});
