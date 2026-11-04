/** Typed driver failure surfaced to the controller with its retry hint. */
export class DriverFailure extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}
