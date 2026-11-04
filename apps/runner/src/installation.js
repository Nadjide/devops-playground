import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const ID = /^[a-f0-9-]{36}$/;

/**
 * Stable installation identity kept in a named volume. It marks ownership of
 * lab resources; it grants no authentication privilege.
 */
export function loadInstallationId(file) {
  if (!file) {
    return randomUUID();
  }
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    if (ID.test(stored.id ?? '')) {
      return stored.id;
    }
  } catch {
    // Missing or unreadable identity: create a fresh one below.
  }
  const id = randomUUID();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ id, createdAt: new Date().toISOString() }), { mode: 0o600 });
  return id;
}
