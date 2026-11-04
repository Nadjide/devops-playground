import { LIMITS } from '../schemas/observations.js';

/* eslint-disable no-control-regex -- these patterns exist to match control characters. */
// ESC-introduced sequences: CSI, OSC (BEL or ST terminated), DCS/SOS/PM/APC, and two-byte escapes.
const ESCAPE_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[PX^_][^\u001b]*(?:\u001b\\)?|[@-Z\\-_])/g;
// C1 control sequence introducer used without ESC.
const C1_CSI = /\u009b[0-?]*[ -/]*[@-~]/g;
// Remaining C0 and C1 controls except horizontal tab.
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g;
/* eslint-enable no-control-regex */

/**
 * Remove terminal escape sequences and replace other control characters so
 * untrusted text cannot move the cursor, change titles, or inject commands.
 */
export function sanitizeTerminalText(value) {
  return String(value)
    .replace(ESCAPE_SEQUENCE, '')
    .replace(C1_CSI, '')
    .replace(CONTROL, '�');
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TRUNCATION_MARKER = ' … [truncated]';

/** Sanitize one log line and bound it to 8 KiB of UTF-8, marking truncation. */
export function sanitizeLogMessage(value) {
  const clean = sanitizeTerminalText(value).trimEnd() || '(empty line)';
  const bytes = encoder.encode(clean);
  if (bytes.length <= LIMITS.logLineBytes) {
    return clean;
  }
  const budget = LIMITS.logLineBytes - encoder.encode(TRUNCATION_MARKER).length;
  // Decoding a cut buffer may end in a partial character; drop the replacement.
  const head = decoder.decode(bytes.slice(0, budget)).replace(/�$/, '');
  return `${head}${TRUNCATION_MARKER}`;
}
