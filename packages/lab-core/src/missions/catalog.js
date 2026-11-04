import stoppedContainer from '../../../../labs/stopped-container/manifest.json' with { type: 'json' };
import { labManifestSchema } from '../schemas/missions.js';

const manifests = [stoppedContainer].map((manifest) => Object.freeze(labManifestSchema.parse(manifest)));

export const labCatalog = Object.freeze(manifests);

export function getLabManifest(labId) {
  const manifest = labCatalog.find((item) => item.id === labId);
  if (!manifest) {
    throw new RangeError(`Unknown lab: ${labId}`);
  }
  return manifest;
}
