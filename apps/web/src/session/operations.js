import { useCallback } from 'react';
import { getStorageProvider } from '@devops-playground/lab-core';
import { useSessionClient, useSessionState } from './SessionContext.jsx';

export const operationLabels = {
  'container.start': 'Start',
  'container.stop': 'Stop',
  'container.restart': 'Restart',
  'container.inspect': 'Inspect',
  'container.logs': 'Read logs',
  'service.configure': 'Apply configuration',
  'health.probe': 'Health probe',
  'version.probe': 'Version probe',
  'pipeline.run': 'Run pipeline',
  'pipeline.rollback': 'Roll back',
  'storage.namespace.create': 'Create storage namespace',
  'storage.namespace.list': 'List storage namespaces',
  'storage.namespace.delete': 'Delete storage namespace',
  'storage.object.put': 'Write object',
  'storage.object.list': 'List objects',
  'storage.object.get': 'Read object',
  'storage.object.delete': 'Delete object',
  'storage.configure': 'Configure storage of',
  'storage.roundtrip.verify': 'Storage check of',
  'session.reset': 'Reset session',
  'session.end': 'End session',
};

/** Provider vocabulary: an S3 lab says bucket where a Blob lab says container. */
const storageLabels = {
  'storage.namespace.create': (profile) => `Create ${profile.namespaceTerm}`,
  'storage.namespace.list': (profile) => `List ${profile.namespacesTerm}`,
  'storage.namespace.delete': (profile) => `Delete ${profile.namespaceTerm}`,
  'storage.object.put': (profile) => `Write ${profile.objectTerm}`,
  'storage.object.list': (profile) => `List ${profile.objectsTerm}`,
  'storage.object.get': (profile) => `Read ${profile.objectTerm}`,
  'storage.object.delete': (profile) => `Delete ${profile.objectTerm}`,
};

export function describeOperation(operation, session = null) {
  const provider = session?.storage?.provider;
  const label = provider && storageLabels[operation.type]
    ? storageLabels[operation.type](getStorageProvider(provider))
    : operationLabels[operation.type] ?? operation.type;
  const { serviceId, namespace, key } = operation.parameters ?? {};
  const target = serviceId ?? (namespace && key ? `${namespace}/${key}` : namespace);
  return target ? `${label} ${target}` : label;
}

export const isActive = (operation) => ['queued', 'running'].includes(operation.status);

/** Dispatch an operation against the current generation; rejections become notices. */
export function useOperationDispatch() {
  const client = useSessionClient();
  return useCallback(async (type, parameters = {}) => {
    const { session } = client.getSnapshot();
    if (!session) {
      return null;
    }
    try {
      return await client.dispatch({ type, generation: session.generation, parameters });
    } catch {
      return null;
    }
  }, [client]);
}

export function useServiceOperations(serviceId) {
  const { session } = useSessionState();
  return (session?.operations ?? []).filter((operation) => operation.parameters.serviceId === serviceId);
}

export function latestSucceeded(operations, type) {
  return operations.findLast((operation) => operation.type === type && operation.status === 'succeeded') ?? null;
}
