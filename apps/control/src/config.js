import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));

/**
 * Trusted startup configuration. Allowed hosts and origins are derived from
 * the loopback portal port; request headers never extend them.
 */
export function loadControlConfig(env = process.env) {
  const mode = env.PLAYGROUND_MODE === 'local' ? 'local' : 'demo';
  const port = Number(env.PORT ?? 3001);
  const publicPort = Number(env.PLAYGROUND_PORT ?? port);
  const hosts = [`127.0.0.1:${publicPort}`, `localhost:${publicPort}`];
  const runnerToken = env.RUNNER_TOKEN ?? '';
  if (mode === 'local' && (!env.RUNNER_URL || runnerToken.length < 32)) {
    throw new Error('Local mode requires RUNNER_URL and a per-launch RUNNER_TOKEN.');
  }
  return {
    mode,
    host: env.HOST ?? '0.0.0.0',
    port,
    allowedHosts: hosts,
    allowedOrigins: hosts.map((host) => `http://${host}`),
    runnerUrl: mode === 'local' ? env.RUNNER_URL : null,
    runnerToken: mode === 'local' ? runnerToken : null,
    staticDir: env.STATIC_DIR ?? DEFAULT_STATIC_DIR,
    cookieSecure: env.COOKIE_SECURE === 'true',
    // Signs CSRF tokens; regenerated per process so restarts invalidate old tokens.
    csrfSecret: randomBytes(32),
  };
}
