import stoppedContainer from '../../../../labs/stopped-container/manifest.json' with { type: 'json' };
import wrongPort from '../../../../labs/wrong-port/manifest.json' with { type: 'json' };
import brokenRelease from '../../../../labs/broken-release/manifest.json' with { type: 'json' };
import freeExploration from '../../../../labs/free-exploration/manifest.json' with { type: 'json' };
import storageProvision from '../../../../labs/storage-provision/manifest.json' with { type: 'json' };
import storageConfig from '../../../../labs/storage-config/manifest.json' with { type: 'json' };
import { labManifestSchema } from '../schemas/missions.js';
import { getFixture } from '../fixtures/catalog.js';

const manifests = [
  stoppedContainer, wrongPort, brokenRelease, storageProvision, storageConfig, freeExploration,
].map((manifest) => {
  const lab = labManifestSchema.parse(manifest);
  for (const fixtureId of lab.fixtureOptions ?? [lab.fixtureId]) {
    getFixture(fixtureId);
  }
  return Object.freeze(lab);
});

export const labCatalog = Object.freeze(manifests);

export function getLabManifest(labId) {
  const manifest = labCatalog.find((item) => item.id === labId);
  if (!manifest) {
    throw new RangeError(`Unknown lab: ${labId}`);
  }
  return manifest;
}

/**
 * Labs a backend can run completely: the mode is supported and every
 * operation an objective may need is implemented by the execution backend.
 */
export function availableLabs({ mode, operations }) {
  return labCatalog.filter((lab) => lab.supportedModes.includes(mode) &&
    lab.allowedOperations.every((type) => operations.includes(type)));
}
