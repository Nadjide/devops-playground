import { SERVICE_NAME } from '../fixtures/releases.js';

/** Health and version evidence must be this recent when it first satisfies an objective. */
export const FRESHNESS_MS = 10_000;
const TARGET_SERVICE = 'api';

const clock = (iso) => `${new Date(iso).toISOString().slice(11, 19)} UTC`;

function targetResource(session) {
  return session.resources.find((resource) => resource.serviceId === TARGET_SERVICE) ?? session.resources[0];
}

function latestProbe(session, resource, kind) {
  return session.probes.findLast((probe) => probe.kind === kind && probe.serviceId === resource.serviceId) ?? null;
}

/** A probe counts only for the current process and while it is fresh at first use. */
function probeIsCurrent(probe, resource, { nowMs, previous }) {
  return resource.observed.state === 'running' &&
    resource.observed.startedAt !== null &&
    Date.parse(probe.observedAt) >= Date.parse(resource.observed.startedAt) &&
    probe.port === resource.desired.expectedProbePort &&
    (previous.status === 'satisfied' || nowMs - Date.parse(probe.observedAt) <= FRESHNESS_MS);
}

/**
 * Explicit predicate registry. Manifests reference these identifiers only;
 * they can never select code paths outside this table.
 * Each predicate returns { holds, observedAt, explanation }.
 */
export const PREDICATES = Object.freeze({
  'evidence.logs-read': Object.freeze({
    // Reading evidence is an event: once observed in a generation it stays satisfied.
    sticky: true,
    evaluate({ session }) {
      const read = session.operations.findLast((operation) => operation.status === 'succeeded' &&
        ['container.logs', 'container.inspect'].includes(operation.type));
      if (!read) {
        return { holds: false };
      }
      const what = read.type === 'container.logs'
        ? `Read ${read.result?.count ?? 0} log line(s) from ${read.parameters.serviceId}`
        : `Inspected ${read.parameters.serviceId} configuration and state`;
      return { holds: true, observedAt: read.finishedAt, explanation: `${what} at ${clock(read.finishedAt)}.` };
    },
  }),

  'service.running': Object.freeze({
    evaluate({ session }) {
      const resource = targetResource(session);
      if (resource?.observed.state !== 'running') {
        return { holds: false };
      }
      return {
        holds: true,
        observedAt: resource.observed.observedAt,
        explanation: `${resource.serviceId} observed running since ${clock(resource.observed.startedAt ?? resource.observed.observedAt)} (${resource.observed.source}).`,
      };
    },
  }),

  'service.health-verified': Object.freeze({
    evaluate(context) {
      const resource = targetResource(context.session);
      const probe = resource && latestProbe(context.session, resource, 'health');
      const valid = probe?.ok && probe.statusCode === 200 && probe.body?.status === 'ok' &&
        probe.body?.service === SERVICE_NAME && probeIsCurrent(probe, resource, context);
      if (!valid) {
        return { holds: false };
      }
      return {
        holds: true,
        observedAt: probe.observedAt,
        explanation: `GET http://${resource.serviceId}:${probe.port}/health returned 200 with status ok for ${SERVICE_NAME} at ${clock(probe.observedAt)} (${probe.source}).`,
      };
    },
  }),

  'service.expected-port': Object.freeze({
    evaluate({ session }) {
      const resource = targetResource(session);
      const { appPort, expectedProbePort } = resource?.desired ?? {};
      const listening = resource?.observed.state === 'running' &&
        resource.observed.ports.some((port) => port.containerPort === expectedProbePort);
      if (!resource || appPort !== expectedProbePort || !listening) {
        return { holds: false };
      }
      return {
        holds: true,
        observedAt: resource.observed.observedAt,
        explanation: `${resource.serviceId} runs with appPort ${appPort}, matching the expected probe port ${expectedProbePort}.`,
      };
    },
  }),

  'service.version-verified': Object.freeze({
    evaluate(context) {
      const resource = targetResource(context.session);
      const probe = resource && latestProbe(context.session, resource, 'version');
      const expected = context.fixture.expectedVersion;
      const valid = probe?.ok && probe.statusCode === 200 && probe.body?.version === expected &&
        probeIsCurrent(probe, resource, context);
      if (!valid) {
        return { holds: false };
      }
      return {
        holds: true,
        observedAt: probe.observedAt,
        explanation: `GET /version returned ${probe.body.version}, the expected release, at ${clock(probe.observedAt)} (${probe.source}).`,
      };
    },
  }),
});
