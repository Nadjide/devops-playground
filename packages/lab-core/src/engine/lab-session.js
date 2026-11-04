import { getLabManifest } from '../missions/catalog.js';
import { createFixtureResources } from '../fixtures/catalog.js';
import { createSession } from './session.js';

const defaultNow = () => new Date().toISOString();
const defaultNextId = () => globalThis.crypto.randomUUID();

/**
 * Create an initializing session for a catalogued lab and its fixture resources.
 * The session ID is generated first so resources carry matching ownership.
 */
export function createLabSession({ labId, mode = 'demo', now = defaultNow, nextId = defaultNextId }) {
  const manifest = getLabManifest(labId);
  const sessionId = nextId();
  const createdAt = now();
  const resources = createFixtureResources(manifest.fixtureId, {
    sessionId,
    generation: 1,
    observedAt: createdAt,
    source: mode === 'demo' ? 'simulator' : 'docker',
  });
  let sessionIdPending = true;
  return createSession({
    manifest,
    mode,
    resources,
    now: () => createdAt,
    nextId: () => {
      if (sessionIdPending) {
        sessionIdPending = false;
        return sessionId;
      }
      return nextId();
    },
  });
}
