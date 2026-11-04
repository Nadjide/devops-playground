export class ClientError extends Error {
  constructor(code, message, { retryable = false, operationId = null, details = {} } = {}) {
    super(message);
    this.name = 'ClientError';
    this.code = code;
    this.retryable = retryable;
    this.operationId = operationId;
    this.details = details;
  }
}

export function toClientError(error) {
  if (error instanceof ClientError) {
    return error;
  }
  return new ClientError(error?.code ?? 'CLIENT_FAILURE', error?.message ?? 'The session client failed.', {
    retryable: true,
  });
}
