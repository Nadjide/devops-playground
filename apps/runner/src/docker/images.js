import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withTimeout } from './diagnostics.js';
import { LABELS } from './labels.js';

export const FIXTURE_DIR = fileURLToPath(new URL('../../../../labs/fixtures/api', import.meta.url));
/** The build context is this allowlist only: no Git metadata, env files, or node_modules. */
export const FIXTURE_FILES = Object.freeze(['Dockerfile', 'package.json', 'server.js', 'tests/server.test.js']);
export const BUILD_TIMEOUT_MS = 5 * 60 * 1000;

export function fixtureDigest(dir = FIXTURE_DIR) {
  const hash = createHash('sha256');
  for (const file of FIXTURE_FILES) {
    hash.update(file).update('\0').update(readFileSync(`${dir}/${file}`)).update('\0');
  }
  return hash.digest('hex').slice(0, 32);
}

/** Build arguments come from the approved release catalog, never from requests. */
export function buildArgsFor(release) {
  return {
    APP_VERSION: release.version,
    STARTUP_MODE: release.startup === 'crash' ? 'require-feature-flags' : 'ok',
  };
}

function followBuild(docker, stream, onLine) {
  return new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (error, output) => {
      const failed = error ?? output?.find((item) => item.error)?.error;
      if (failed) {
        reject(Object.assign(new Error(typeof failed === 'string' ? failed : failed.message), { code: 'IMAGE_BUILD_FAILED' }));
      } else {
        resolve(output);
      }
    }, (event) => {
      const text = event.stream ?? event.status;
      if (text?.trim()) {
        onLine?.(text.trim());
      }
    });
  });
}

/**
 * Build (or reuse) the approved image for a release. Images are shared across
 * sessions and labeled with the installation and fixture digest.
 */
export async function ensureReleaseImage(docker, release, { installationId, onLine, force = false } = {}) {
  const digest = fixtureDigest();
  if (!force) {
    try {
      const existing = await docker.getImage(release.image).inspect();
      if (existing.Config?.Labels?.[LABELS.digest] === digest) {
        return { built: false, id: existing.Id, logs: [] };
      }
    } catch (error) {
      if (error?.statusCode !== 404) {
        throw error;
      }
    }
  }
  const logs = [];
  const stream = await docker.buildImage({ context: FIXTURE_DIR, src: [...FIXTURE_FILES] }, {
    t: release.image,
    buildargs: buildArgsFor(release),
    labels: {
      [LABELS.managed]: 'true',
      [LABELS.installation]: installationId,
      [LABELS.release]: release.id,
      [LABELS.digest]: digest,
    },
    rm: true,
    forcerm: true,
  });
  await withTimeout(followBuild(docker, stream, (line) => {
    logs.push(line);
    onLine?.(line);
  }), BUILD_TIMEOUT_MS, 'IMAGE_BUILD_TIMEOUT');
  const image = await docker.getImage(release.image).inspect();
  return { built: true, id: image.Id, logs };
}
