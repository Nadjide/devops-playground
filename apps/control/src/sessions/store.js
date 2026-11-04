import { createLabRuntime, createSystemClock, DomainError } from '@devops-playground/lab-core';

export const ACTIVE_SESSION_LIMIT = 1;

/**
 * Owns local sessions. Each session is bound to the browser session that
 * created it; reads and mutations by any other browser look like 404s.
 */
export function createSessionStore({
  executorFactory,
  clock = createSystemClock(),
  nextId = () => globalThis.crypto.randomUUID(),
  onError = () => {},
}) {
  const sessions = new Map();

  const isOpen = (entry) => entry.runtime.getSession()?.status !== 'ended';

  return {
    async create({ owner, labId, fixtureId }) {
      for (const [id, entry] of sessions) {
        if (!isOpen(entry)) {
          entry.runtime.dispose();
          sessions.delete(id);
        }
      }
      if ([...sessions.values()].filter(isOpen).length >= ACTIVE_SESSION_LIMIT) {
        throw new DomainError('CAPACITY_EXCEEDED', 'A local session is already active. End it before starting another.', {
          status: 429, retryable: true,
        });
      }
      const runtime = createLabRuntime({
        labId,
        fixtureId: fixtureId ?? undefined,
        mode: 'local',
        source: 'docker',
        executor: executorFactory(),
        clock,
        nextId,
        onError,
      });
      await runtime.start();
      const session = runtime.getSession();
      sessions.set(session.id, { owner, runtime });
      return session;
    },
    get(id, owner) {
      const entry = sessions.get(id);
      return entry && entry.owner === owner ? entry.runtime : null;
    },
    list: () => [...sessions.values()].map((entry) => entry.runtime.getSession()),
    listOwned: (owner) => [...sessions.values()].filter((entry) => entry.owner === owner).map((entry) => entry.runtime.getSession()),
    /** End open sessions so the runner removes their resources before the controller exits. */
    async shutdown({ timeoutMs = 20_000 } = {}) {
      const ends = [...sessions.values()].filter(isOpen).map(async ({ runtime }) => {
        const session = runtime.getSession();
        if (!['active', 'degraded'].includes(session.status)) {
          return;
        }
        const operation = runtime.submit({ type: 'session.end', generation: session.generation, parameters: {} },
          { idempotencyKey: `shutdown-${session.generation}` });
        await runtime.settled(operation.id);
      });
      await Promise.race([Promise.allSettled(ends), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
    },
    dispose() {
      for (const entry of sessions.values()) {
        entry.runtime.dispose();
      }
      sessions.clear();
    },
  };
}
