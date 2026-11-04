import { OperationFailure } from '../engine/errors.js';
import { getStorageProvider, isApprovedEndpoint } from './providers.js';

/**
 * Checks shared by every storage backend. They run before any backend call,
 * so an invalid name or an external endpoint never reaches the network.
 */
export function providerFailure(error, { retryable = false } = {}) {
  return new OperationFailure(error.code, error.message, { retryable });
}

export function requireNamespaceName(providerId, name) {
  const profile = getStorageProvider(providerId);
  const problem = profile.validateNamespace(name);
  if (problem) {
    throw providerFailure(profile.errors.invalidName(problem));
  }
}

export function requireApprovedEndpoint(providerId, endpoint) {
  const profile = getStorageProvider(providerId);
  if (!isApprovedEndpoint(providerId, endpoint)) {
    throw new OperationFailure('ENDPOINT_NOT_ALLOWED',
      `${endpoint} is not the session's ${profile.label} emulator. Only ${profile.endpoint} is approved; real cloud and external endpoints are refused.`);
  }
}

export function findNamespace(storage, name) {
  return storage.namespaces.find((namespace) => namespace.name === name) ?? null;
}

export function requireNamespace(storage, name) {
  const namespace = findNamespace(storage, name);
  if (!namespace) {
    throw providerFailure(getStorageProvider(storage.provider).errors.namespaceMissing(name));
  }
  return namespace;
}

/** Lab-owned namespaces can change; others stay readable but untouched. */
export function requireOwnedNamespace(storage, name) {
  const namespace = requireNamespace(storage, name);
  if (!namespace.owned) {
    const profile = getStorageProvider(storage.provider);
    throw new OperationFailure('NAMESPACE_NOT_OWNED',
      `The ${profile.namespaceTerm} ${name} is not owned by this lab. It can be listed and read, but not changed.`);
  }
  return namespace;
}

export function storageTargetLine(storage, target) {
  const profile = getStorageProvider(storage.provider);
  return { provider: profile.id, term: profile.namespaceTerm, namespace: target.namespace, endpoint: target.endpoint };
}
