/**
 * Approved workload releases. Images are referenced by these exact names in
 * both modes; the local runner builds them from `labs/fixtures`.
 */
export const API_IMAGE = 'devops-playground-lab/api';
export const SERVICE_NAME = 'devops-playground';

const releases = {
  [`${API_IMAGE}:1.0.0`]: {
    image: `${API_IMAGE}:1.0.0`,
    version: '1.0.0',
    startup: 'ok',
  },
  [`${API_IMAGE}:1.1.0`]: {
    image: `${API_IMAGE}:1.1.0`,
    version: '1.1.0',
    startup: 'crash',
  },
};

export const releaseCatalog = Object.freeze(Object.values(releases).map((release) => Object.freeze(release)));

export function getRelease(image) {
  const release = releases[image];
  if (!release) {
    throw new RangeError(`Unapproved image: ${image}`);
  }
  return release;
}

/** Log lines printed by the fixture workload; kept identical to labs/fixtures/api. */
export const workloadLines = {
  startup: (release, appPort) => [
    { stream: 'stdout', level: 'info', message: `> ${SERVICE_NAME}@${release.version} start` },
    { stream: 'stdout', level: 'info', message: `Configuration loaded: APP_PORT=${appPort}` },
    { stream: 'stdout', level: 'info', message: `DevOps Playground API ${release.version} listening on port ${appPort}` },
  ],
  shutdown: () => [
    { stream: 'stdout', level: 'info', message: 'Received SIGTERM, closing HTTP server' },
    { stream: 'stdout', level: 'info', message: 'HTTP server closed, exiting with code 0' },
  ],
  crash: (release) => [
    { stream: 'stdout', level: 'info', message: `> ${SERVICE_NAME}@${release.version} start` },
    { stream: 'stderr', level: 'error', message: 'Error: FEATURE_FLAGS_URL is required by release 1.1.0 but is not configured' },
    { stream: 'stderr', level: 'error', message: '    at loadConfiguration (/app/src/config.js:14:11)' },
    { stream: 'stderr', level: 'error', message: 'Startup aborted, exiting with code 1' },
  ],
};
