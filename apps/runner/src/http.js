import { createHash, timingSafeEqual } from 'node:crypto';

export function errorBody(code, message, { retryable = false, details = {} } = {}) {
  return { error: { code, message, retryable, operationId: null, details } };
}

const digest = (value) => createHash('sha256').update(value).digest();

/**
 * Only the controller may call the runner: requests carrying a browser Origin
 * are refused, and the bearer token is compared in constant time.
 */
export function requireRunnerToken(token) {
  const expected = digest(token);
  return (req, res, next) => {
    if (req.get('origin') || req.get('sec-fetch-site')) {
      res.status(403).json(errorBody('BROWSER_ORIGIN_REJECTED', 'The runner does not accept browser requests.'));
      return;
    }
    const match = /^Bearer ([A-Za-z0-9_-]{1,512})$/.exec(req.get('authorization') ?? '');
    if (!match || !timingSafeEqual(digest(match[1]), expected)) {
      res.status(401).json(errorBody('UNAUTHENTICATED', 'A valid runner token is required.'));
      return;
    }
    next();
  };
}
