import { PREDICATES } from './predicates.js';

/**
 * Re-evaluate every objective against the current snapshot after `event`.
 * Returns the next mission progress, or null when nothing changed.
 * Completion requires every required objective to hold at the same revision
 * and is then kept as a historical record even if the service degrades.
 */
export function evaluateMission(session, lab, { event, nowMs, fixture }) {
  const mission = session.mission;
  const objectives = lab.objectives.map((definition, index) => {
    const current = mission.objectives[index];
    const predicate = PREDICATES[definition.predicateId];
    if (predicate.sticky && current.status === 'satisfied') {
      return current;
    }
    const result = predicate.evaluate({ session, fixture, nowMs, previous: current });
    if (result.holds) {
      if (current.status === 'satisfied') {
        return current;
      }
      return {
        id: current.id,
        status: 'satisfied',
        evidence: {
          eventId: event.id,
          generation: session.generation,
          revision: event.revision,
          source: event.source,
          observedAt: result.observedAt,
          explanation: result.explanation,
        },
      };
    }
    // Keep the last evidence so learners can see what used to hold.
    return current.status === 'satisfied' ? { ...current, status: 'invalidated' } : current;
  });

  let completion = mission.completion;
  const requiredHold = lab.objectives.length > 0 && lab.objectives.every((definition, index) =>
    !definition.required || objectives[index].status === 'satisfied');
  if (!completion && requiredHold) {
    completion = {
      eventId: event.id,
      generation: session.generation,
      revision: event.revision,
      completedAt: event.occurredAt,
    };
  }

  const started = session.operations.length > 0 || objectives.some((objective) => objective.status !== 'pending');
  const status = completion ? 'completed' : (started || mission.status !== 'not-started' ? 'in-progress' : 'not-started');
  const next = { id: mission.id, status, objectives, completion };
  return JSON.stringify(next) === JSON.stringify(mission) ? null : next;
}
