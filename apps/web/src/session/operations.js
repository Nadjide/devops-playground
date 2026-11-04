import { useCallback } from 'react';
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
  'session.reset': 'Reset session',
  'session.end': 'End session',
};

export function describeOperation(operation) {
  const label = operationLabels[operation.type] ?? operation.type;
  const target = operation.parameters?.serviceId;
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
