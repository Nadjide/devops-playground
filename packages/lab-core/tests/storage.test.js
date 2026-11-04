import { describe, expect, it } from 'vitest';
import {
  commandContext, getStorageProvider, objectKeySchema, operationRequestSchema, parseCommand, reduceSession,
  serializeCheckpoint, sessionSchema, sha256Hex, STORAGE_LIMITS, storageStateSchema,
} from '../src/index.js';
import { startRuntime } from './runtime-helpers.js';

const s3 = getStorageProvider('aws-s3');

describe('S3 naming rules', () => {
  it.each([
    ['lab-reports', null],
    ['logs.2026.archive', null],
    ['ab', 'between 3 and 63'],
    ['a'.repeat(64), 'between 3 and 63'],
    ['Lab-Reports', 'lowercase'],
    ['lab_reports', 'lowercase'],
    ['-reports', 'begin and end'],
    ['lab..reports', 'adjacent periods'],
    ['192.168.10.4', 'IP address'],
    ['xn--reports', 'reserved prefix'],
    ['reports-s3alias', 'reserved suffix'],
  ])('validates %s', (name, problem) => {
    const result = s3.validateNamespace(name);
    if (problem === null) {
      expect(result).toBeNull();
    } else {
      expect(result).toContain(problem);
    }
  });

  it('accepts only flat object keys that can never be paths', () => {
    for (const key of ['notes.txt', 'report_2026-11.csv', 'a']) {
      expect(objectKeySchema.safeParse(key).success).toBe(true);
    }
    for (const key of ['../etc/passwd', 'dir/file.txt', '.hidden', 'a..b', '', 'x'.repeat(129), 'C:\\temp']) {
      expect(objectKeySchema.safeParse(key).success).toBe(false);
    }
  });

  it('rejects oversized or control-character content before execution', () => {
    const request = (content) => operationRequestSchema.safeParse({
      type: 'storage.object.put', generation: 1, parameters: { namespace: 'lab-reports', key: 'a.txt', content },
    });
    expect(request('line one\nline two\ttab').success).toBe(true);
    expect(request('x'.repeat(STORAGE_LIMITS.objectBytes + 1)).success).toBe(false);
    expect(request('bell\u0007').success).toBe(false);
  });
});

describe('simulated S3 operations', () => {
  it('creates, writes, reads, and deletes owned storage with provider errors', async () => {
    const { run, valid } = await startRuntime({ labId: 'storage-provision' });
    expect((await run('storage.namespace.create', { namespace: 'Lab_Reports' })).error.code).toBe('INVALID_BUCKET_NAME');
    expect((await run('storage.namespace.create', { namespace: 'shared-audit-logs' })).error.code).toBe('BUCKET_ALREADY_EXISTS');
    expect((await run('storage.namespace.create', { namespace: 'lab-reports' })).status).toBe('succeeded');
    expect((await run('storage.namespace.create', { namespace: 'lab-reports' })).error.code).toBe('BUCKET_ALREADY_OWNED_BY_YOU');

    const put = await run('storage.object.put', { namespace: 'lab-reports', key: 'notes.txt', content: 'hello' });
    expect(put.result).toMatchObject({ bytes: 5, sha256: await sha256Hex('hello'), uri: 's3://lab-reports/notes.txt' });
    const get = await run('storage.object.get', { namespace: 'lab-reports', key: 'notes.txt' });
    expect(get.result).toMatchObject({ content: 'hello', truncated: false, sha256: put.result.sha256 });
    expect((await run('storage.object.get', { namespace: 'lab-reports', key: 'other.txt' })).error.code).toBe('NO_SUCH_KEY');
    expect((await run('storage.object.list', { namespace: 'missing-bucket' })).error.code).toBe('NO_SUCH_BUCKET');

    // S3 refuses to delete a non-empty bucket; deleting a missing key succeeds.
    expect((await run('storage.namespace.delete', { namespace: 'lab-reports' })).error.code).toBe('BUCKET_NOT_EMPTY');
    expect((await run('storage.object.delete', { namespace: 'lab-reports', key: 'other.txt' })).result.deleted).toBe(false);
    expect((await run('storage.object.delete', { namespace: 'lab-reports', key: 'notes.txt' })).result.deleted).toBe(true);
    expect((await run('storage.namespace.delete', { namespace: 'lab-reports' })).status).toBe('succeeded');
    expect(valid().storage.namespaces.map((namespace) => namespace.name)).toEqual(['shared-audit-logs']);
  });

  it('keeps namespaces the lab does not own read-only', async () => {
    const { run, valid } = await startRuntime({ labId: 'storage-provision' });
    expect((await run('storage.object.get', { namespace: 'shared-audit-logs', key: 'retention-policy.txt' })).status).toBe('succeeded');
    for (const [type, parameters] of [
      ['storage.object.put', { namespace: 'shared-audit-logs', key: 'x.txt', content: 'x' }],
      ['storage.object.delete', { namespace: 'shared-audit-logs', key: 'retention-policy.txt' }],
      ['storage.namespace.delete', { namespace: 'shared-audit-logs' }],
      ['storage.configure', { serviceId: 'api', namespace: 'shared-audit-logs' }],
    ]) {
      expect((await run(type, parameters)).error.code).toBe('NAMESPACE_NOT_OWNED');
    }
    expect(valid().storage.objects).toHaveLength(1);
  });

  it('bounds object count and simulated content', async () => {
    const { run, valid } = await startRuntime({ labId: 'storage-provision' });
    await run('storage.namespace.create', { namespace: 'lab-reports' });
    const big = 'x'.repeat(STORAGE_LIMITS.objectBytes);
    expect((await run('storage.object.put', { namespace: 'lab-reports', key: 'a.txt', content: big })).status).toBe('succeeded');
    expect((await run('storage.object.put', { namespace: 'lab-reports', key: 'b.txt', content: big.slice(1000) })).status).toBe('succeeded');
    expect((await run('storage.object.put', { namespace: 'lab-reports', key: 'c.txt', content: big })).error.code).toBe('STORAGE_QUOTA');
    // Overwriting reuses the object's own budget.
    expect((await run('storage.object.put', { namespace: 'lab-reports', key: 'a.txt', content: big })).status).toBe('succeeded');
    const preview = await run('storage.object.get', { namespace: 'lab-reports', key: 'a.txt' });
    expect(preview.result).toMatchObject({ truncated: true, bytes: STORAGE_LIMITS.objectBytes });
    expect(preview.result.content).toHaveLength(STORAGE_LIMITS.previewBytes);

    await run('storage.object.delete', { namespace: 'lab-reports', key: 'a.txt' });
    await run('storage.object.delete', { namespace: 'lab-reports', key: 'b.txt' });
    for (let index = valid().storage.objects.length; index < STORAGE_LIMITS.objects; index += 1) {
      expect((await run('storage.object.put', { namespace: 'lab-reports', key: `k${index}.txt`, content: 'x' })).status).toBe('succeeded');
    }
    expect((await run('storage.object.put', { namespace: 'lab-reports', key: 'one-more.txt', content: 'x' })).error.code).toBe('STORAGE_LIMIT');
    expect(valid().storage.objects).toHaveLength(STORAGE_LIMITS.objects);
  });

  it('refuses external endpoints before any change', async () => {
    const { run, api } = await startRuntime({ labId: 'storage-config' });
    for (const endpoint of ['https://s3.amazonaws.com', 'http://169.254.169.254', 'http://storage:5001']) {
      const result = await run('storage.configure', { serviceId: 'api', namespace: 'lab-reports', endpoint });
      expect(result.error.code).toBe('ENDPOINT_NOT_ALLOWED');
    }
    expect(api().desired.storage).toEqual({ namespace: 'lab-report', endpoint: 'http://storage:5000' });
    const malformed = operationRequestSchema.safeParse({
      type: 'storage.configure', generation: 1, parameters: { serviceId: 'api', namespace: 'lab-reports', endpoint: 'file:///etc/passwd' },
    });
    expect(malformed.success).toBe(false);
  });
});

describe('storage missions', () => {
  it('requires the workload round trip, not a listing, for connectivity', async () => {
    const { run, valid } = await startRuntime({ labId: 'storage-provision' });
    const failed = await run('storage.roundtrip.verify', { serviceId: 'api' });
    expect(failed.error.code).toBe('STORAGE_CHECK_FAILED');
    expect(valid().storage.roundTrips.at(-1)).toMatchObject({ ok: false, statusCode: 503, error: expect.stringContaining('NoSuchBucket') });

    await run('storage.namespace.create', { namespace: 'lab-reports' });
    await run('storage.object.put', { namespace: 'lab-reports', key: 'notes.txt', content: 'report' });
    await run('storage.object.list', { namespace: 'lab-reports' });
    await run('storage.object.get', { namespace: 'lab-reports', key: 'notes.txt' });
    const objectives = () => Object.fromEntries(valid().mission.objectives.map((item) => [item.id, item.status]));
    expect(objectives()).toEqual({ 'create-namespace': 'satisfied', 'write-read': 'satisfied', 'verify-roundtrip': 'pending' });

    await run('storage.roundtrip.verify', { serviceId: 'api' });
    expect(valid().mission.status).toBe('completed');
    const check = valid().storage.roundTrips.at(-1);
    expect(check).toMatchObject({ ok: true, statusCode: 200, key: 'storage-check.txt', source: 'simulator' });
    expect(check.observedSha256).toBe(check.expectedSha256);
  });

  it('does not count reading an object nobody wrote in this session', async () => {
    const { run, valid } = await startRuntime({ labId: 'storage-provision' });
    await run('storage.object.get', { namespace: 'shared-audit-logs', key: 'retention-policy.txt' });
    expect(valid().mission.objectives.find((item) => item.id === 'write-read').status).toBe('pending');
  });

  it('fails the check while the workload is unreachable', async () => {
    const { run } = await startRuntime({ labId: 'storage-config' });
    await run('container.stop', { serviceId: 'api' });
    const result = await run('storage.roundtrip.verify', { serviceId: 'api' });
    expect(result.error).toMatchObject({ code: 'WORKLOAD_UNREACHABLE', retryable: true });
  });

  it('repairs the misconfiguration only with the bucket that holds the data', async () => {
    const { run, valid, api } = await startRuntime({ labId: 'storage-config' });
    await run('container.logs', { serviceId: 'api', tail: 20 });
    // Creating the misspelled bucket makes the check pass but is not the repair.
    await run('storage.namespace.create', { namespace: 'lab-report' });
    await run('storage.roundtrip.verify', { serviceId: 'api' });
    expect(valid().mission.status).toBe('in-progress');

    const configured = await run('storage.configure', { serviceId: 'api', namespace: 'lab-reports' });
    expect(configured.result).toMatchObject({ changed: true, replaced: true, state: 'running' });
    expect(api().desired.storage.namespace).toBe('lab-reports');
    // The replaced process has no round trip yet.
    expect(valid().mission.objectives.find((item) => item.id === 'verify-roundtrip').status).not.toBe('satisfied');
    await run('storage.roundtrip.verify', { serviceId: 'api' });
    expect(valid().mission.status).toBe('completed');
  });

  it('reset restores the fixture storage and clears evidence', async () => {
    const { run, valid } = await startRuntime({ labId: 'storage-provision' });
    await run('storage.namespace.create', { namespace: 'lab-reports' });
    await run('storage.object.put', { namespace: 'lab-reports', key: 'notes.txt', content: 'x' });
    const reset = await run('session.reset', {});
    expect(reset.status).toBe('succeeded');
    const session = valid();
    expect(session.generation).toBe(2);
    expect(session.storage.namespaces.map((namespace) => namespace.name)).toEqual(['shared-audit-logs']);
    expect(session.storage.roundTrips).toEqual([]);
    expect(session.mission.objectives.every((item) => item.status === 'pending')).toBe(true);
  });

  it('keeps simulated storage within the checkpoint budget', async () => {
    const { run, valid } = await startRuntime({ labId: 'storage-provision' });
    await run('storage.namespace.create', { namespace: 'lab-reports' });
    await run('storage.object.put', { namespace: 'lab-reports', key: 'notes.txt', content: 'y'.repeat(60_000) });
    expect(serializeCheckpoint(valid())).toMatchObject({ ok: true });
  });
});

describe('storage state contract', () => {
  it('rejects storage provenance that does not match the mode', async () => {
    const { valid } = await startRuntime({ labId: 'storage-provision' });
    const session = valid();
    const forged = { ...session, storage: { ...session.storage, namespaces: session.storage.namespaces.map((item) => ({ ...item, source: 'emulator' })) } };
    expect(sessionSchema.safeParse(forged).success).toBe(false);
    const withoutContent = {
      ...session,
      storage: { ...session.storage, objects: session.storage.objects.map((object) => ({ ...object, content: undefined })) },
    };
    expect(sessionSchema.safeParse(withoutContent).success).toBe(false);
  });

  it('rejects objects outside observed namespaces and duplicate names', async () => {
    const { valid } = await startRuntime({ labId: 'storage-config' });
    const { storage } = valid();
    expect(storageStateSchema.safeParse({ ...storage, namespaces: storage.namespaces.slice(1) }).success).toBe(false);
    expect(storageStateSchema.safeParse({ ...storage, namespaces: [...storage.namespaces, storage.namespaces[0]] }).success).toBe(false);
  });

  it('refuses storage events in sessions without storage', async () => {
    const { valid } = await startRuntime();
    const session = valid();
    const event = {
      schemaVersion: 1,
      id: `${session.id}:${session.eventEpoch}:${session.lastEventSequence + 1}`,
      sessionId: session.id,
      generation: 1,
      eventEpoch: session.eventEpoch,
      sequence: session.lastEventSequence + 1,
      revision: session.revision + 1,
      type: 'storage.namespace-observed',
      occurredAt: session.updatedAt,
      operationId: null,
      source: 'simulator',
      payload: { name: 'lab-reports', state: 'present', owned: true, createdAt: null },
    };
    expect(() => reduceSession(session, event)).toThrow(/no cloud storage/);
  });
});

describe('aws s3 terminal grammar', () => {
  const context = (provider = 'aws-s3') => ({ ...commandContext({
    fixtureId: 's3-unprovisioned', resources: [{ serviceId: 'api', desired: { expectedProbePort: 3000 } }],
    storage: provider ? { provider } : null,
  }) });

  it.each([
    ['aws s3 ls', 'storage.namespace.list', {}],
    ['aws s3 ls s3://lab-reports', 'storage.object.list', { namespace: 'lab-reports' }],
    ['aws s3 mb s3://lab-reports', 'storage.namespace.create', { namespace: 'lab-reports' }],
    ['aws s3 cp s3://lab-reports/notes.txt -', 'storage.object.get', { namespace: 'lab-reports', key: 'notes.txt' }],
    ['aws s3 rm s3://lab-reports/notes.txt', 'storage.object.delete', { namespace: 'lab-reports', key: 'notes.txt' }],
    ['curl http://api:3000/storage-check', 'storage.roundtrip.verify', { serviceId: 'api' }],
  ])('maps %s to %s', (input, type, parameters) => {
    expect(parseCommand(input, context())).toMatchObject({ kind: 'operation', request: { type, parameters } });
  });

  it.each([
    ['aws s3 rb s3://lab-reports', 'Cloud panel'],
    ['aws s3 cp notes.txt s3://lab-reports/notes.txt', 'no file system'],
    ['aws s3 ls --endpoint-url https://s3.amazonaws.com', 'session emulator'],
    ['aws s3 cp s3://lab-reports/dir/notes.txt -', 'slashes'],
    ['aws iam list-users', 'Only aws s3'],
  ])('rejects %s', (input, message) => {
    expect(parseCommand(input, context())).toMatchObject({ kind: 'error', message: expect.stringContaining(message) });
  });

  it('refuses storage commands in labs without storage', () => {
    expect(parseCommand('aws s3 ls', context(null))).toMatchObject({ kind: 'error' });
    expect(parseCommand('curl http://api:3000/storage-check', context(null))).toMatchObject({ kind: 'error' });
  });
});
