export const PREFIX = 'devops-playground';

export const LABELS = Object.freeze({
  managed: `${PREFIX}.managed`,
  installation: `${PREFIX}.installation`,
  session: `${PREFIX}.session`,
  generation: `${PREFIX}.generation`,
  lab: `${PREFIX}.lab`,
  service: `${PREFIX}.service`,
  release: `${PREFIX}.release`,
  digest: `${PREFIX}.fixture-digest`,
  role: `${PREFIX}.role`,
  fixture: `${PREFIX}.fixture`,
});

export function ownershipLabels({ installationId, sessionId, generation, labId, fixtureId }) {
  return {
    ...(fixtureId ? { [LABELS.fixture]: fixtureId } : {}),
    [LABELS.managed]: 'true',
    [LABELS.installation]: installationId,
    [LABELS.session]: sessionId,
    [LABELS.generation]: String(generation),
    [LABELS.lab]: labId,
  };
}

/** Docker filter for resources owned by this installation, optionally narrowed. */
export function ownershipFilter({ installationId, sessionId, generation, serviceId }) {
  const label = [`${LABELS.managed}=true`, `${LABELS.installation}=${installationId}`];
  if (sessionId) {
    label.push(`${LABELS.session}=${sessionId}`);
  }
  if (generation !== undefined) {
    label.push(`${LABELS.generation}=${generation}`);
  }
  if (serviceId) {
    label.push(`${LABELS.service}=${serviceId}`);
  }
  return { label };
}

/** Re-verify labels on the inspected object right before acting on it. */
export function isOwned(labels, { installationId, sessionId, generation }) {
  return labels?.[LABELS.managed] === 'true' &&
    labels[LABELS.installation] === installationId &&
    (sessionId === undefined || labels[LABELS.session] === sessionId) &&
    (generation === undefined || labels[LABELS.generation] === String(generation));
}

/** Deterministic, short, Docker-safe names scoped to a session generation. */
export function resourceName(sessionId, generation, suffix = '') {
  const short = sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12).toLowerCase();
  return `dpg-${short}-g${generation}${suffix ? `-${suffix}` : ''}`;
}
