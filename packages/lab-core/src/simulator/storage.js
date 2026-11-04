import { OperationFailure } from '../engine/errors.js';
import { STORAGE_LIMITS, utf8Bytes } from '../schemas/storage.js';
import { workloadLines } from '../fixtures/releases.js';
import {
  contentPreview, getStorageProvider, sha256Hex, STORAGE_CHECK_KEY, storageCheckPayload,
} from '../storage/providers.js';
import {
  findNamespace, providerFailure, requireApprovedEndpoint, requireNamespace, requireNamespaceName,
  requireOwnedNamespace,
} from '../storage/validate.js';

function requireStorage(ctx) {
  const storage = ctx.session().storage;
  if (!storage) {
    throw new OperationFailure('STORAGE_UNAVAILABLE', 'This lab has no cloud storage.');
  }
  return storage;
}

/** Simulated content shares the checkpoint budget, so the session keeps a total quota. */
function requireCapacity(storage, namespace, key, bytes) {
  const existing = storage.objects.find((object) => object.namespace === namespace && object.key === key);
  if (!existing && storage.objects.length >= STORAGE_LIMITS.objects) {
    throw new OperationFailure('STORAGE_LIMIT', `Sessions hold at most ${STORAGE_LIMITS.objects} objects. Delete one first.`);
  }
  const used = storage.objects.reduce((total, object) => total + object.bytes, 0) - (existing?.bytes ?? 0);
  if (used + bytes > STORAGE_LIMITS.simulatedBytes) {
    throw new OperationFailure('STORAGE_QUOTA', 'Simulated storage keeps at most 128 KiB of text per session. Delete an object first.');
  }
}

function objectSummary(object) {
  return { key: object.key, bytes: object.bytes, sha256: object.sha256, updatedAt: object.updatedAt, writer: object.writer };
}

/**
 * Deterministic, session-scoped storage for Demo mode. It implements the same
 * operation contract as the local emulator adapters and reports every change
 * as an observation, so the Cloud panel and objectives read one snapshot.
 */
export function createStorageHandlers({ timings, replace }) {
  const pause = (ctx) => ctx.delay(timings.storage);

  async function createNamespace(operation, ctx) {
    await pause(ctx);
    const storage = requireStorage(ctx);
    const { namespace } = operation.parameters;
    const profile = getStorageProvider(storage.provider);
    requireNamespaceName(storage.provider, namespace);
    const existing = findNamespace(storage, namespace);
    if (existing) {
      throw providerFailure(existing.owned ? profile.errors.namespaceExists(namespace) : profile.errors.namespaceTaken(namespace));
    }
    if (storage.namespaces.length >= STORAGE_LIMITS.namespaces) {
      throw new OperationFailure('STORAGE_LIMIT', `Sessions hold at most ${STORAGE_LIMITS.namespaces} ${profile.namespacesTerm}.`);
    }
    ctx.emit('storage.namespace-observed', { name: namespace, state: 'present', owned: true, createdAt: ctx.now() });
    return { namespace, created: true, uri: profile.uri(namespace) };
  }

  async function listNamespaces(operation, ctx) {
    await pause(ctx);
    const storage = requireStorage(ctx);
    return {
      namespaces: storage.namespaces.map((namespace) => ({
        name: namespace.name,
        owned: namespace.owned,
        objects: storage.objects.filter((object) => object.namespace === namespace.name).length,
      })),
    };
  }

  async function deleteNamespace(operation, ctx) {
    await pause(ctx);
    const storage = requireStorage(ctx);
    const { namespace } = operation.parameters;
    const profile = getStorageProvider(storage.provider);
    requireOwnedNamespace(storage, namespace);
    const objects = storage.objects.filter((object) => object.namespace === namespace).length;
    if (objects > 0 && !profile.deletesNonEmptyNamespace) {
      throw providerFailure(profile.errors.namespaceNotEmpty(namespace));
    }
    ctx.emit('storage.namespace-observed', { name: namespace, state: 'absent' });
    return { namespace, deleted: true, objectsRemoved: objects };
  }

  async function putObject(operation, ctx) {
    await pause(ctx);
    const storage = requireStorage(ctx);
    const { namespace, key, content } = operation.parameters;
    const profile = getStorageProvider(storage.provider);
    requireOwnedNamespace(storage, namespace);
    const bytes = utf8Bytes(content);
    requireCapacity(storage, namespace, key, bytes);
    const sha256 = await sha256Hex(content);
    ctx.emit('storage.object-observed', {
      namespace, key, state: 'present', bytes, sha256, updatedAt: ctx.now(), writer: 'console', content,
    });
    return { namespace, key, bytes, sha256, uri: profile.uri(namespace, key) };
  }

  async function listObjects(operation, ctx) {
    await pause(ctx);
    const storage = requireStorage(ctx);
    const { namespace } = operation.parameters;
    requireNamespace(storage, namespace);
    return {
      namespace,
      objects: storage.objects.filter((object) => object.namespace === namespace).map(objectSummary),
    };
  }

  async function getObject(operation, ctx) {
    await pause(ctx);
    const storage = requireStorage(ctx);
    const { namespace, key } = operation.parameters;
    const profile = getStorageProvider(storage.provider);
    requireNamespace(storage, namespace);
    const object = storage.objects.find((item) => item.namespace === namespace && item.key === key);
    if (!object) {
      throw providerFailure(profile.errors.objectMissing(namespace, key));
    }
    const { preview, truncated } = contentPreview(object.content);
    return { namespace, key, ...objectSummary(object), content: preview, truncated, uri: profile.uri(namespace, key) };
  }

  async function deleteObject(operation, ctx) {
    await pause(ctx);
    const storage = requireStorage(ctx);
    const { namespace, key } = operation.parameters;
    const profile = getStorageProvider(storage.provider);
    requireOwnedNamespace(storage, namespace);
    const object = storage.objects.find((item) => item.namespace === namespace && item.key === key);
    if (!object) {
      if (profile.missingObjectDeleteSucceeds) {
        return { namespace, key, deleted: false };
      }
      throw providerFailure(profile.errors.objectMissing(namespace, key));
    }
    ctx.emit('storage.object-observed', { namespace, key, state: 'absent' });
    return { namespace, key, deleted: true };
  }

  /** Point the workload at another namespace or endpoint; the container is replaced to apply it. */
  async function configure(operation, ctx) {
    const storage = requireStorage(ctx);
    const { serviceId, namespace } = operation.parameters;
    const resource = ctx.session().resources.find((item) => item.serviceId === serviceId);
    if (!resource.desired.storage) {
      throw new OperationFailure('STORAGE_NOT_SUPPORTED', `${serviceId} has no storage configuration.`);
    }
    const endpoint = operation.parameters.endpoint ?? resource.desired.storage.endpoint;
    requireNamespaceName(storage.provider, namespace);
    if (operation.parameters.endpoint !== undefined) {
      requireApprovedEndpoint(storage.provider, endpoint);
    }
    const existing = findNamespace(storage, namespace);
    if (existing && !existing.owned) {
      throw new OperationFailure('NAMESPACE_NOT_OWNED',
        `${serviceId} may only use storage owned by this lab; ${namespace} belongs to someone else.`);
    }
    const current = resource.desired.storage;
    if (current.namespace === namespace && current.endpoint === endpoint) {
      return { serviceId, namespace, endpoint, changed: false, replaced: false };
    }
    const wasRunning = ['running', 'starting'].includes(resource.observed.state);
    const updated = await replace(ctx, resource, { storage: { namespace, endpoint } }, { startAfter: wasRunning });
    return { serviceId, namespace, endpoint, changed: true, replaced: true, state: updated.observed.state };
  }

  /**
   * GET /storage-check on the workload: the service writes a fresh payload
   * through its own configured target and reads it back.
   */
  async function roundTrip(operation, ctx) {
    const { serviceId } = operation.parameters;
    await ctx.delay(timings.probe);
    const storage = requireStorage(ctx);
    const resource = ctx.session().resources.find((item) => item.serviceId === serviceId);
    const target = resource.desired.storage;
    if (!target) {
      throw new OperationFailure('STORAGE_NOT_SUPPORTED', `${serviceId} has no storage check endpoint.`);
    }
    const port = resource.desired.expectedProbePort;
    if (resource.observed.state !== 'running' || resource.desired.appPort !== port) {
      throw new OperationFailure('WORKLOAD_UNREACHABLE',
        `GET http://${serviceId}:${port}/storage-check failed: connect ECONNREFUSED ${serviceId}:${port}`, { retryable: true });
    }
    const profile = getStorageProvider(storage.provider);
    const started = Date.parse(ctx.now());
    await ctx.delay(timings.storage);
    const payload = storageCheckPayload({
      provider: storage.provider, namespace: target.namespace, nonce: `${ctx.session().generation}-${ctx.session().revision}`,
    });
    const expectedSha256 = await sha256Hex(payload);
    const bytes = utf8Bytes(payload);
    const uri = profile.uri(target.namespace, STORAGE_CHECK_KEY);
    const base = {
      serviceId, provider: storage.provider, endpoint: target.endpoint, namespace: target.namespace,
      key: STORAGE_CHECK_KEY, bytes, expectedSha256,
    };
    let error = null;
    if (target.endpoint !== storage.endpoint) {
      const host = target.endpoint.replace(/^https?:\/\//, '').split('/')[0];
      error = `connect ECONNREFUSED ${host}`;
    } else if (!findNamespace(storage, target.namespace)) {
      error = profile.errors.namespaceMissing(target.namespace).message;
    } else {
      try {
        requireCapacity(storage, target.namespace, STORAGE_CHECK_KEY, bytes);
      } catch (failure) {
        error = failure.message;
      }
    }
    const durationMs = Date.parse(ctx.now()) - started;
    if (error) {
      ctx.emitLogs(workloadLines.storageCheck({ ok: false, uri, error }).map((line) => ({ ...line, serviceId, at: ctx.now() })));
      ctx.emit('storage.roundtrip-completed', {
        ...base, ok: false, observedSha256: null, statusCode: 503, error, durationMs,
      });
      throw new OperationFailure('STORAGE_CHECK_FAILED', `GET http://${serviceId}:${port}/storage-check returned 503: ${error}`, { retryable: true });
    }
    ctx.emit('storage.object-observed', {
      namespace: target.namespace, key: STORAGE_CHECK_KEY, state: 'present', bytes, sha256: expectedSha256,
      updatedAt: ctx.now(), writer: 'workload', content: payload,
    });
    const stored = ctx.session().storage.objects.find((object) => object.namespace === target.namespace && object.key === STORAGE_CHECK_KEY);
    const observedSha256 = await sha256Hex(stored.content);
    ctx.emitLogs(workloadLines.storageCheck({ ok: true, uri, sha256: observedSha256 }).map((line) => ({ ...line, serviceId, at: ctx.now() })));
    ctx.emit('storage.roundtrip-completed', {
      ...base, ok: observedSha256 === expectedSha256, observedSha256, statusCode: 200, error: null, durationMs,
    });
    return { serviceId, ok: true, statusCode: 200, namespace: target.namespace, key: STORAGE_CHECK_KEY, bytes, sha256: observedSha256, uri };
  }

  return {
    'storage.namespace.create': createNamespace,
    'storage.namespace.list': listNamespaces,
    'storage.namespace.delete': deleteNamespace,
    'storage.object.put': putObject,
    'storage.object.list': listObjects,
    'storage.object.get': getObject,
    'storage.object.delete': deleteObject,
    'storage.configure': configure,
    'storage.roundtrip.verify': roundTrip,
  };
}
