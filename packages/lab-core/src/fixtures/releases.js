/**
 * Approved workload releases. Images are referenced by these exact names in
 * both modes; the local runner builds them from `labs/fixtures`.
 */
export const API_IMAGE = 'devops-playground-lab/api';
/** Storage-capable variant of the API used by the cloud storage labs. */
export const STORAGE_API_IMAGE = 'devops-playground-lab/storage-api';
export const SERVICE_NAME = 'devops-playground';

const definitions = [
  { id: 'api-1-0-0', version: '1.0.0', startup: 'ok', summary: 'Known-good baseline release' },
  { id: 'api-1-0-1', version: '1.0.1', startup: 'ok', summary: 'Patch release that starts normally' },
  { id: 'api-1-1-0', version: '1.1.0', startup: 'crash', summary: 'Candidate that requires missing configuration at startup' },
];

const storageDefinitions = [
  { id: 'storage-api-1-0-0', version: '1.0.0', startup: 'ok', summary: 'API with a storage round-trip check' },
];

export const releaseCatalog = Object.freeze([
  ...definitions.map((release) => ({ ...release, image: `${API_IMAGE}:${release.version}` })),
  ...storageDefinitions.map((release) => ({ ...release, image: `${STORAGE_API_IMAGE}:${release.version}` })),
].map((release) => Object.freeze(release)));

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
  startup: (release, appPort, storage = null) => [
    { stream: 'stdout', level: 'info', message: `> ${SERVICE_NAME}@${release.version} start` },
    { stream: 'stdout', level: 'info', message: `Configuration loaded: APP_PORT=${appPort}` },
    ...(storage ? [{ stream: 'stdout', level: 'info', message: `Storage target: ${storage.provider} ${storage.term} ${storage.namespace} at ${storage.endpoint}` }] : []),
    { stream: 'stdout', level: 'info', message: `DevOps Playground API ${release.version} listening on port ${appPort}` },
  ],
  shutdown: () => [
    { stream: 'stdout', level: 'info', message: 'Received SIGTERM, closing HTTP server' },
    { stream: 'stdout', level: 'info', message: 'HTTP server closed, exiting with code 0' },
  ],
  storageCheck: ({ ok, uri, sha256, error }) => (ok
    ? [{ stream: 'stdout', level: 'info', message: `Storage check passed: wrote and read back ${uri} (sha256 ${sha256.slice(0, 12)})` }]
    : [{ stream: 'stderr', level: 'error', message: `Storage check failed for ${uri}: ${error}` }]),
  crash: (release) => [
    { stream: 'stdout', level: 'info', message: `> ${SERVICE_NAME}@${release.version} start` },
    { stream: 'stderr', level: 'error', message: `Error: FEATURE_FLAGS_URL is required by release ${release.version} but is not configured` },
    { stream: 'stderr', level: 'error', message: '    at loadConfiguration (/app/src/config.js:14:11)' },
    { stream: 'stderr', level: 'error', message: 'Startup aborted, exiting with code 1' },
  ],
};
