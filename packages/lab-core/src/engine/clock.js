import { AbortedError } from './errors.js';

/** Wall clock used by the browser demo and the local controller. */
export function createSystemClock() {
  return {
    now: () => Date.now(),
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
  };
}

/**
 * Deterministic clock for tests. Time only moves through `advance`, which
 * fires due timers in order and lets promise continuations settle between them.
 */
export function createVirtualClock(start = Date.parse('2026-11-04T10:00:00.000Z')) {
  let current = start;
  let counter = 0;
  const timers = new Map();
  const settle = () => new Promise((resolve) => globalThis.setTimeout(resolve, 0));

  function nextDue(limit) {
    let due = null;
    for (const timer of timers.values()) {
      if (timer.at <= limit && (!due || timer.at < due.at || (timer.at === due.at && timer.id < due.id))) {
        due = timer;
      }
    }
    return due;
  }

  const clock = {
    now: () => current,
    setTimeout(callback, ms = 0) {
      counter += 1;
      timers.set(counter, { id: counter, at: current + Math.max(0, ms), callback });
      return counter;
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
    pendingTimers: () => timers.size,
    async advance(ms) {
      const target = current + ms;
      await settle();
      for (let timer = nextDue(target); timer; timer = nextDue(target)) {
        timers.delete(timer.id);
        current = timer.at;
        timer.callback();
        await settle();
      }
      current = target;
      await settle();
    },
    async runAll(maxSteps = 10_000) {
      for (let step = 0; step < maxSteps; step += 1) {
        await settle();
        const timer = nextDue(Number.POSITIVE_INFINITY);
        if (!timer) {
          return;
        }
        await clock.advance(timer.at - current);
      }
      throw new Error('Virtual clock did not become idle.');
    },
  };
  return clock;
}

/** Promise-based delay that honours an AbortSignal. */
export function delay(clock, ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError());
      return;
    }
    const onAbort = () => {
      clock.clearTimeout(handle);
      reject(new AbortedError());
    };
    const handle = clock.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
