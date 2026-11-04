export const HISTORY_LIMIT = 100;
export const TRANSCRIPT_LIMIT = 1000;

/** Bounded command history with shell-like up/down navigation. */
export function createCommandHistory(limit = HISTORY_LIMIT) {
  let entries = [];
  let cursor = 0;
  return {
    push(command) {
      const value = command.trim();
      if (value && entries.at(-1) !== value) {
        entries = [...entries, value].slice(-limit);
      }
      cursor = entries.length;
    },
    previous() {
      cursor = Math.max(0, cursor - 1);
      return entries[cursor] ?? '';
    },
    next() {
      cursor = Math.min(entries.length, cursor + 1);
      return entries[cursor] ?? '';
    },
    reset() {
      cursor = entries.length;
    },
    entries: () => entries,
  };
}

/**
 * Terminal presentation state that outlives the xterm instance, so switching
 * panels does not lose output. Clearing it never touches domain events.
 */
export function createTerminalState() {
  let chunks = [];
  return {
    history: createCommandHistory(),
    append(chunk) {
      chunks = [...chunks, chunk].slice(-TRANSCRIPT_LIMIT);
    },
    clear() {
      chunks = [];
    },
    transcript: () => chunks,
  };
}
