import express from 'express';
import { errorBody, requireRunnerToken } from './http.js';
import { diagnoseDocker } from './docker/diagnostics.js';
import { createSessionRouter } from './routes/sessions.js';

/**
 * Internal runner API. It is reachable only on the private management
 * network, publishes no host port, and accepts only authenticated controller
 * requests with validated payloads.
 */
export function createRunnerApp({ config, docker, driver = null, diagnose = diagnoseDocker, now = () => new Date().toISOString() }) {
  const app = express();
  const startedAt = Date.now();
  app.disable('x-powered-by');
  app.use(requireRunnerToken(config.token));
  app.use(express.json({ limit: '64kb' }));

  app.get('/v1/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'devops-playground-runner',
      uptime: (Date.now() - startedAt) / 1000,
      timestamp: now(),
    });
  });

  app.get('/v1/docker', async (req, res) => {
    const diagnostics = await diagnose(docker);
    res.status(diagnostics.available ? 200 : 503).json(diagnostics);
  });

  if (driver) {
    app.use('/v1/sessions', createSessionRouter({ driver }));
  }

  app.use((req, res) => {
    res.status(404).json(errorBody('NOT_FOUND', 'Unknown runner route.'));
  });

  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
  app.use((error, req, res, next) => {
    if (error?.type === 'entity.too.large') {
      res.status(413).json(errorBody('PAYLOAD_TOO_LARGE', 'Runner requests are limited to 64 KiB.'));
      return;
    }
    if (error?.type === 'entity.parse.failed') {
      res.status(400).json(errorBody('MALFORMED_JSON', 'The request body is not valid JSON.'));
      return;
    }
    res.status(500).json(errorBody('RUNNER_FAILURE', 'The runner failed to handle the request.', { retryable: true }));
  });

  return app;
}
