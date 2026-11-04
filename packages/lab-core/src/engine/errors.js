/**
 * Typed rejection of a request at a runtime boundary. `status` follows the
 * HTTP mapping of the management API so local and demo clients agree.
 */
export class DomainError extends Error {
  constructor(code, message, { status = 409, retryable = false, operationId = null, details = {} } = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.operationId = operationId;
    this.details = details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      operationId: this.operationId,
      details: this.details,
    };
  }
}

/** Failure raised by an executor while performing an accepted operation. */
export class OperationFailure extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = 'OperationFailure';
    this.code = code;
    this.retryable = retryable;
  }
}

export class AbortedError extends Error {
  constructor(message = 'The operation was cancelled.') {
    super(message);
    this.name = 'AbortError';
    this.code = 'OPERATION_CANCELLED';
  }
}
