import {
  contentPreview, getFixture, getStorageProvider, isApprovedEndpoint, roundTripObservationSchema, STORAGE_CHECK_KEY,
  STORAGE_LIMITS,
} from '@devops-playground/lab-core';
import { DriverFailure } from '../docker/errors.js';
import { createEmulatorContainer, emulatorFor, ensureEmulatorImage, waitForEmulator } from '../docker/emulators.js';
import { createS3Adapter, LAB_OWNER, S3_REGION, S3_TEST_CREDENTIALS } from './s3-adapter.js';
import { AZURITE_ACCOUNT, AZURITE_ACCOUNT_KEY, BLOB_API_VERSION, createBlobAdapter } from './blob-adapter.js';

const ADAPTERS = { 'aws-s3': createS3Adapter, 'azure-blob': createBlobAdapter };

/** Environment for a storage-capable workload: its target plus the emulator's test-only settings. */
export function workloadStorageEnv(provider, target) {
  if (provider === 'aws-s3') {
    return [
      'STORAGE_PROVIDER=aws-s3',
      `STORAGE_ENDPOINT=${target.endpoint}`,
      `STORAGE_NAMESPACE=${target.namespace}`,
      `AWS_ACCESS_KEY_ID=${S3_TEST_CREDENTIALS.accessKeyId}`,
      `AWS_SECRET_ACCESS_KEY=${S3_TEST_CREDENTIALS.secretAccessKey}`,
      `AWS_REGION=${S3_REGION}`,
    ];
  }
  if (provider === 'azure-blob') {
    return [
      'STORAGE_PROVIDER=azure-blob',
      `STORAGE_ENDPOINT=${target.endpoint}`,
      `STORAGE_NAMESPACE=${target.namespace}`,
      `AZURE_STORAGE_ACCOUNT=${AZURITE_ACCOUNT}`,
      `AZURE_STORAGE_KEY=${AZURITE_ACCOUNT_KEY}`,
      `AZURE_STORAGE_API_VERSION=${BLOB_API_VERSION}`,
    ];
  }
  throw new DriverFailure('PROVIDER_UNAVAILABLE', `The local runner has no emulator for ${provider} yet.`);
}

function failure(error) {
  return new DriverFailure(error.code, error.message);
}

/**
 * Real storage for the cloud labs: one pinned emulator per session generation,
 * reached through provider SDK adapters with explicit endpoints and test
 * credentials. Every change is reported as an `emulator` observation.
 */
export function createStorageDriver({ docker, installationId, adapters = ADAPTERS }) {
  function adapterFor(provider, endpoint) {
    const create = adapters[provider];
    if (!create) {
      throw new DriverFailure('PROVIDER_UNAVAILABLE', `The local runner has no emulator for ${provider} yet.`);
    }
    return create({ endpoint });
  }

  async function withAdapter(provider, work) {
    const adapter = adapterFor(provider, getStorageProvider(provider).endpoint);
    try {
      return await work(adapter);
    } finally {
      adapter.destroy?.();
    }
  }

  /** Namespaces and object metadata as the emulator reports them. */
  async function observeState(adapter, provider) {
    const now = new Date().toISOString();
    const namespaces = await adapter.listNamespaces();
    const objects = [];
    for (const namespace of namespaces) {
      for (const object of await adapter.listObjects(namespace.name)) {
        objects.push({
          namespace: namespace.name, ...object, writer: object.key === STORAGE_CHECK_KEY ? 'workload' : 'fixture', source: 'emulator', observedAt: now,
        });
      }
    }
    return {
      provider,
      endpoint: getStorageProvider(provider).endpoint,
      namespaces: namespaces.map((namespace) => ({ ...namespace, source: 'emulator', observedAt: now })),
      objects: objects.slice(0, STORAGE_LIMITS.objects),
      roundTrips: [],
    };
  }

  /** Start the session emulator, seed the fixture, and observe the result. */
  async function provision({ session, network, onLine }) {
    const seed = getFixture(session.fixtureId).storage;
    if (!seed) {
      return null;
    }
    const emulator = emulatorFor(seed.provider);
    await ensureEmulatorImage(docker, emulator, { onLine });
    const container = await createEmulatorContainer(docker, { installationId, session, emulator, network });
    await container.start();
    onLine?.(`Started ${emulator.label} emulator as storage on the session network`);
    return withAdapter(seed.provider, async (adapter) => {
      await waitForEmulator(adapter);
      for (const namespace of seed.namespaces) {
        await adapter.createNamespace(namespace.name, { owner: namespace.owned ? LAB_OWNER : 'platform-team' });
      }
      for (const object of seed.objects) {
        await adapter.putObject(object.namespace, object.key, object.content);
      }
      return observeState(adapter, seed.provider);
    });
  }

  async function recoverState(provider) {
    return withAdapter(provider, (adapter) => observeState(adapter, provider));
  }

  function requireStorage(session) {
    if (!session.storage) {
      throw new DriverFailure('STORAGE_UNAVAILABLE', 'This lab has no cloud storage.');
    }
    return session.storage;
  }

  async function requireOwned(adapter, profile, namespace) {
    const owner = await adapter.ownerOf(namespace);
    if (owner !== LAB_OWNER) {
      throw new DriverFailure('NAMESPACE_NOT_OWNED',
        `The ${profile.namespaceTerm} ${namespace} is not owned by this lab. It can be listed and read, but not changed.`);
    }
  }

  function requireName(profile, namespace) {
    const problem = profile.validateNamespace(namespace);
    if (problem) {
      throw failure(profile.errors.invalidName(problem));
    }
  }

  /** Re-observe one namespace's objects and report what changed. */
  async function reconcileObjects(adapter, storage, namespace, out) {
    const listed = await adapter.listObjects(namespace);
    const known = storage.objects.filter((object) => object.namespace === namespace);
    for (const object of known) {
      if (!listed.some((item) => item.key === object.key)) {
        out.emit('storage.object-observed', { namespace, key: object.key, state: 'absent' }, { source: 'emulator' });
      }
    }
    for (const object of listed) {
      const previous = known.find((item) => item.key === object.key);
      if (!previous || previous.sha256 !== object.sha256) {
        out.emit('storage.object-observed', {
          namespace, key: object.key, state: 'present', bytes: object.bytes, sha256: object.sha256, updatedAt: object.updatedAt,
          writer: previous?.writer ?? (object.key === STORAGE_CHECK_KEY ? 'workload' : 'console'),
        }, { source: 'emulator' });
      }
    }
    return listed;
  }

  async function execute({ session, operation, out }) {
    const storage = requireStorage(session);
    const profile = getStorageProvider(storage.provider);
    const { type, parameters } = operation;
    const { namespace, key } = parameters;


    return withAdapter(storage.provider, async (adapter) => {
      switch (type) {
        case 'storage.namespace.create': {
          requireName(profile, namespace);
          const existing = (await adapter.listNamespaces()).find((item) => item.name === namespace);
          if (existing) {
            throw failure(existing.owned ? profile.errors.namespaceExists(namespace) : profile.errors.namespaceTaken(namespace));
          }
          if (storage.namespaces.length >= STORAGE_LIMITS.namespaces) {
            throw new DriverFailure('STORAGE_LIMIT', `Sessions hold at most ${STORAGE_LIMITS.namespaces} ${profile.namespacesTerm}.`);
          }
          await adapter.createNamespace(namespace);
          out.emit('storage.namespace-observed', { name: namespace, state: 'present', owned: true, createdAt: new Date().toISOString() }, { source: 'emulator' });
          return { namespace, created: true, uri: profile.uri(namespace) };
        }
        case 'storage.namespace.list': {
          const listed = await adapter.listNamespaces();
          for (const known of storage.namespaces) {
            if (!listed.some((item) => item.name === known.name)) {
              out.emit('storage.namespace-observed', { name: known.name, state: 'absent' }, { source: 'emulator' });
            }
          }
          for (const item of listed) {
            const known = storage.namespaces.find((namespaceItem) => namespaceItem.name === item.name);
            if (!known || known.owned !== item.owned) {
              out.emit('storage.namespace-observed', { name: item.name, state: 'present', owned: item.owned, createdAt: item.createdAt }, { source: 'emulator' });
            }
          }
          return {
            namespaces: listed.map((item) => ({
              name: item.name, owned: item.owned, objects: storage.objects.filter((object) => object.namespace === item.name).length,
            })),
          };
        }
        case 'storage.namespace.delete': {
          await requireOwned(adapter, profile, namespace);
          const objects = (await adapter.listObjects(namespace)).length;
          if (objects > 0 && !profile.deletesNonEmptyNamespace) {
            throw failure(profile.errors.namespaceNotEmpty(namespace));
          }
          await adapter.deleteNamespace(namespace);
          out.emit('storage.namespace-observed', { name: namespace, state: 'absent' }, { source: 'emulator' });
          return { namespace, deleted: true, objectsRemoved: objects };
        }
        case 'storage.object.put': {
          await requireOwned(adapter, profile, namespace);
          const exists = storage.objects.some((object) => object.namespace === namespace && object.key === key);
          if (!exists && storage.objects.length >= STORAGE_LIMITS.objects) {
            throw new DriverFailure('STORAGE_LIMIT', `Sessions hold at most ${STORAGE_LIMITS.objects} objects. Delete one first.`);
          }
          const written = await adapter.putObject(namespace, key, parameters.content);
          const read = await adapter.readObject(namespace, key);
          out.emit('storage.object-observed', {
            namespace, key, state: 'present', bytes: read.bytes, sha256: read.sha256, updatedAt: read.updatedAt, writer: 'console',
          }, { source: 'emulator' });
          return { namespace, key, bytes: written.bytes, sha256: written.sha256, uri: profile.uri(namespace, key) };
        }
        case 'storage.object.list': {
          const listed = await reconcileObjects(adapter, storage, namespace, out);
          const writers = new Map(storage.objects.filter((object) => object.namespace === namespace).map((object) => [object.key, object.writer]));
          return {
            namespace,
            objects: listed.map((object) => ({ ...object, writer: writers.get(object.key) ?? (object.key === STORAGE_CHECK_KEY ? 'workload' : 'console') })),
          };
        }
        case 'storage.object.get': {
          const object = await adapter.readObject(namespace, key);
          const known = storage.objects.find((item) => item.namespace === namespace && item.key === key);
          const writer = known?.writer ?? (key === STORAGE_CHECK_KEY ? 'workload' : 'console');
          if (!known || known.sha256 !== object.sha256) {
            out.emit('storage.object-observed', {
              namespace, key, state: 'present', bytes: object.bytes, sha256: object.sha256, updatedAt: object.updatedAt, writer,
            }, { source: 'emulator' });
          }
          const { preview, truncated } = contentPreview(object.content);
          return {
            namespace, key, bytes: object.bytes, sha256: object.sha256, updatedAt: object.updatedAt, writer,
            content: preview, truncated, uri: profile.uri(namespace, key),
          };
        }
        case 'storage.object.delete': {
          await requireOwned(adapter, profile, namespace);
          const exists = await adapter.objectExists(namespace, key);
          if (!exists && !profile.missingObjectDeleteSucceeds) {
            throw failure(profile.errors.objectMissing(namespace, key));
          }
          await adapter.deleteObject(namespace, key);
          if (exists) {
            out.emit('storage.object-observed', { namespace, key, state: 'absent' }, { source: 'emulator' });
          }
          return { namespace, key, deleted: exists };
        }
        default:
          throw new DriverFailure('UNSUPPORTED_OPERATION', `${type} is not supported by the local runner.`);
      }
    });
  }

  /** Validate a requested workload target before the workload is touched. */
  async function validateTarget({ storage, parameters, current }) {
    const profile = getStorageProvider(storage.provider);
    requireName(profile, parameters.namespace);
    const endpoint = parameters.endpoint ?? current.endpoint;
    if (parameters.endpoint !== undefined && !isApprovedEndpoint(storage.provider, endpoint)) {
      throw new DriverFailure('ENDPOINT_NOT_ALLOWED',
        `${endpoint} is not the session's ${profile.label} emulator. Only ${profile.endpoint} is approved; real cloud and external endpoints are refused.`);
    }
    const existing = await withAdapter(storage.provider, async (adapter) => (await adapter.listNamespaces()).find((item) => item.name === parameters.namespace));
    if (existing && !existing.owned) {
      throw new DriverFailure('NAMESPACE_NOT_OWNED',
        `${parameters.serviceId} may only use storage owned by this lab; ${parameters.namespace} belongs to someone else.`);
    }
    return { namespace: parameters.namespace, endpoint };
  }

  /** Validate a workload's storage-check response before it becomes evidence. */
  function roundTripFrom(serviceId, probe) {
    const body = probe.body ?? {};
    const candidate = {
      serviceId,
      ok: Boolean(body.ok) && probe.statusCode === 200,
      provider: body.provider,
      endpoint: body.endpoint,
      namespace: body.namespace,
      key: body.key,
      bytes: body.bytes,
      expectedSha256: body.expectedSha256,
      observedSha256: body.observedSha256 ?? null,
      statusCode: probe.statusCode,
      error: body.ok ? null : (body.error ?? probe.error ?? `HTTP ${probe.statusCode}`),
      durationMs: probe.durationMs,
    };
    const parsed = roundTripObservationSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new DriverFailure('WORKLOAD_RESPONSE_INVALID', `GET /storage-check returned a response that does not match the storage-check contract (HTTP ${probe.statusCode}).`);
    }
    return parsed.data;
  }

  /** Observe the workload's check object after a storage check. */
  async function observeCheckObject({ session, namespace, out }) {
    const storage = requireStorage(session);
    return withAdapter(storage.provider, (adapter) => reconcileObjects(adapter, storage, namespace, out).catch(() => null));
  }

  return { provision, recoverState, execute, validateTarget, roundTripFrom, observeCheckObject };
}
