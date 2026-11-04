/**
 * Approved workload releases. Images are referenced by these exact names in
 * both modes; the local runner builds them from `labs/fixtures`.
 */
export const API_IMAGE = 'devops-playground-lab/api';
export const SERVICE_NAME = 'devops-playground';

const definitions = [
  { id: 'api-1-0-0', version: '1.0.0', startup: 'ok', summary: 'Known-good baseline release' },
  { id: 'api-1-0-1', version: '1.0.1', startup: 'ok', summary: 'Patch release that starts normally' },
  { id: 'api-1-1-0', version: '1.1.0', startup: 'crash', summary: 'Candidate that requires missing configuration at startup' },
];

export const releaseCatalog = Object.freeze(definitions.map((release) => Object.freeze({
  ...release,
  image: `${API_IMAGE}:${release.version}`,
})));

export function getRelease(image) {
  const release = releaseCatalog.find((item) => item.image === image);
  if (!release) {
    throw new RangeError(`Unapproved image: ${image}`);
  }
  return release;
}

export function getReleaseById(releaseId) {
  const release = releaseCatalog.find((item) => item.id === releaseId);
  if (!release) {
    throw new RangeError(`Unapproved release: ${releaseId}`);
  }
  return release;
}

export function releaseRef(release) {
  return { releaseId: release.id, image: release.image, version: release.version };
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
    { stream: 'stderr', level: 'error', message: `Error: FEATURE_FLAGS_URL is required by release ${release.version} but is not configured` },
    { stream: 'stderr', level: 'error', message: '    at loadConfiguration (/app/src/config.js:14:11)' },
    { stream: 'stderr', level: 'error', message: 'Startup aborted, exiting with code 1' },
  ],
};
