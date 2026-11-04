import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sendError } from './errors.js';

export const SESSION_COOKIE = 'pg_session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A forged Host header is a rejection, never configuration (DNS rebinding defence). */
export function hostGuard(allowedHosts) {
  return (req, res, next) => {
    if (!allowedHosts.includes(req.get('host') ?? '')) {
      sendError(res, 403, 'HOST_REJECTED', 'The request host is not allowed.');
      return;
    }
    next();
  };
}

/**
 * Same-origin only: mutations need an allowed Origin, and reads that declare
 * a foreign Origin or a cross-site fetch are refused. No CORS headers are sent.
 */
export function originGuard(allowedOrigins) {
  return (req, res, next) => {
    const origin = req.get('origin');
    const site = req.get('sec-fetch-site');
    const foreign = (origin && !allowedOrigins.includes(origin)) || site === 'cross-site';
    if (foreign || (!SAFE_METHODS.has(req.method) && !origin)) {
      sendError(res, 403, 'ORIGIN_REJECTED', 'Requests must come from the workbench origin.');
      return;
    }
    next();
  };
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return index === -1 ? [part, ''] : [part.slice(0, index), part.slice(index + 1)];
  }));
}

/** Assign every browser an opaque HttpOnly SameSite=Strict session identifier. */
export function browserSession({ secure }) {
  return (req, res, next) => {
    let id = parseCookies(req.get('cookie'))[SESSION_COOKIE];
    if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) {
      id = randomBytes(32).toString('base64url');
      res.append('Set-Cookie', `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
    }
    req.browserSession = id;
    next();
  };
}

export function csrfTokenFor(secret, browserSessionId) {
  return createHmac('sha256', secret).update(`csrf:${browserSessionId}`).digest('base64url');
}

export function requireCsrf(secret) {
  return (req, res, next) => {
    const given = Buffer.from(req.get('x-csrf-token') ?? '');
    const expected = Buffer.from(csrfTokenFor(secret, req.browserSession));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      sendError(res, 403, 'CSRF_REJECTED', 'A valid CSRF token for this browser session is required.');
      return;
    }
    next();
  };
}

export function securityHeaders() {
  return (req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    next();
  };
}
