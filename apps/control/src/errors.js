import { randomUUID } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, code, message, { retryable = false, operationId = null, details = {} } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.operationId = operationId;
    this.details = details;
  }
}

export function sendError(res, status, code, message, { retryable = false, operationId = null, details = {} } = {}) {
  res.status(status).json({ error: { code, message, retryable, operationId, details } });
}

/** Final error handler: typed errors keep their status; anything else is a safe 500. */
export function errorHandler(logger = console) {
  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
  return (error, req, res, next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error?.type === 'entity.too.large') {
      sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request bodies are limited to 64 KiB.');
      return;
    }
    if (error?.type === 'entity.parse.failed') {
      sendError(res, 400, 'MALFORMED_JSON', 'The request body is not valid JSON.');
      return;
    }
    if (error instanceof ApiError || (typeof error?.status === 'number' && typeof error?.code === 'string')) {
      sendError(res, error.status, error.code, error.message, {
        retryable: Boolean(error.retryable),
        operationId: error.operationId ?? null,
        details: error.details ?? {},
      });
      return;
    }
    const correlationId = randomUUID();
    logger.error?.(`[${correlationId}] Unhandled control error: ${error?.stack ?? error}`);
    sendError(res, 500, 'INTERNAL_ERROR', 'The control service failed unexpectedly.', {
      retryable: true,
      details: { correlationId },
    });
  };
}
