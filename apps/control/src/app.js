import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { errorHandler } from './errors.js';
import { browserSession, hostGuard, originGuard, securityHeaders } from './security.js';
import { createApiRouter } from './routes/api.js';

function loadIndex(staticDir, mode) {
  try {
    const html = readFileSync(join(staticDir, 'index.html'), 'utf8');
    // The packaged portal tells the static app which session client to load.
    return html.replace('<head>', `<head>\n    <meta name="devops-playground-mode" content="${mode}" />`);
  } catch {
    return null;
  }
}

/**
 * Workbench control application: serves the built workbench and the
 * management API from one loopback origin. It stays up when workloads fail.
 */
export function createControlApp({ config, store, runner, operations = [], executorFactory = null, logger = console, now = () => new Date().toISOString() }) {
  const app = express();
  const startedAt = Date.now();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(securityHeaders());

  // Management health only; it never reports workload health.
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'devops-playground-control',
      mode: config.mode,
      uptime: (Date.now() - startedAt) / 1000,
      timestamp: now(),
    });
  });

  app.use(hostGuard(config.allowedHosts));
  // Operation requests may carry a 64 KiB storage object; every other body stays within 64 KiB.
  const operationBody = express.json({ limit: '160kb' });
  app.use('/api', originGuard(config.allowedOrigins), browserSession({ secure: config.cookieSecure }),
    (req, res, next) => (req.method === 'POST' && /^\/sessions\/[^/]+\/operations$/.test(req.path) ? operationBody(req, res, next) : next()),
    express.json({ limit: '64kb' }), createApiRouter({ config, store, runner, operations, executorFactory }));

  const index = loadIndex(config.staticDir, config.mode);
  app.use(express.static(config.staticDir, { index: false, maxAge: '1h', fallthrough: true }));
  app.get(/^\/(?!api\/).*/, (req, res) => {
    if (!index) {
      res.status(503).type('text').send('The workbench build is missing. Run npm run build:playground.');
      return;
    }
    res.set('Cache-Control', 'no-store').type('html').send(index);
  });

  app.use(errorHandler(logger));
  return app;
}
