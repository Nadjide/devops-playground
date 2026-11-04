import {
  createFixturePipeline, emptyPipeline, freshMission, getLabManifest, getRelease, SESSION_SCHEMA_VERSION, sessionSchema,
} from '@devops-playground/lab-core';

/**
 * Rebuild a session snapshot from re-observed, label-verified resources after
 * a controller restart. The session keeps its ID and generation, starts a new
 * event epoch, and treats every objective as unverified until re-observed.
 * The previous run history is not recoverable and is not invented.
 */
export function recoveredSnapshot({ recovered, nextId, now }) {
  const { session, resources } = recovered;
  const lab = getLabManifest(session.labId);
  const baseline = createFixturePipeline(session.fixtureId, { now, source: null });
  const api = resources.find((resource) => resource.serviceId === 'api');
  let deployed = null;
  if (api) {
    const release = getRelease(api.desired.image);
    deployed = { releaseId: release.id, image: release.image, version: release.version, status: 'unverified' };
  }
  return sessionSchema.parse({
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: session.id,
    mode: 'local',
    labId: lab.id,
    fixtureId: session.fixtureId,
    revision: 0,
    generation: session.generation,
    eventEpoch: nextId(),
    status: 'active',
    resources,
    operations: [],
    mission: freshMission(lab),
    probes: [],
    logs: { entries: [], dropped: 0, bytes: 0, nextSeq: 1 },
    pipeline: { ...emptyPipeline(), knownGood: baseline.knownGood, deployed },
    // Re-observed from the session emulator by the runner; earlier round trips are not restored.
    storage: recovered.storage ?? null,
    lastEventSequence: 0,
    createdAt: now,
    updatedAt: now,
  });
}
