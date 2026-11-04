export class ClientError extends Error {
  constructor(code, message, { retryable = false, operationId = null, status = null, details = {} } = {}) {
    super(message);
    this.name = 'ClientError';
    this.code = code;
    this.retryable = retryable;
    this.operationId = operationId;
    this.status = status;
    this.details = details;
  }
}

export function toClientError(error) {
  if (error instanceof ClientError) {
    return error;
  }
  return new ClientError(error?.code ?? 'CLIENT_FAILURE', error?.message ?? 'The session client failed.', {
    retryable: error?.retryable ?? true,
    operationId: error?.operationId ?? null,
    status: error?.status ?? null,
    details: error?.details ?? {},
  });
}
