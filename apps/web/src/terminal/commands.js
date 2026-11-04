import {
  COMMAND_HELP, commandContext, getLabManifest, parseCommand, sanitizeTerminalText,
} from '@devops-playground/lab-core';
import { describeOperation } from '../session/operations.js';

const line = (text, tone = 'default') => ({ text, tone });

function table(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join('   ').trimEnd());
}

function dockerPs(session) {
  const rows = [['SERVICE', 'IMAGE', 'STATE', 'HEALTH', 'PORTS']];
  for (const resource of session.resources) {
    const exit = resource.observed.exitCode !== null && resource.observed.state !== 'running' ? ` (${resource.observed.exitCode})` : '';
    rows.push([
      resource.serviceId,
      resource.observed.image ?? resource.desired.image,
      `${resource.observed.state}${exit}`,
      resource.observed.health,
      resource.observed.ports.map((port) => `${port.containerPort}/tcp`).join(', ') || '-',
    ]);
  }
  return table(rows).map((text, index) => line(text, index === 0 ? 'muted' : 'default'));
}

function labStatus(session, mode) {
  const lab = getLabManifest(session.labId);
  const done = session.mission.objectives.filter((objective) => objective.status === 'satisfied').length;
  return [
    line(`Lab        ${lab.title} (${lab.id})`),
    line(`Mode       ${mode === 'demo' ? 'Demo (simulated)' : 'Local Docker'}`),
    line(`Session    ${session.status}, generation ${session.generation}, revision ${session.revision}`),
    line(`Mission    ${session.mission.status}, ${done}/${session.mission.objectives.length} objectives satisfied`),
    ...session.resources.map((resource) => line(
      `Service    ${resource.serviceId}: ${resource.observed.state}, health ${resource.observed.health}, appPort ${resource.desired.appPort}`)),
  ];
}

function help() {
  const width = Math.max(...COMMAND_HELP.map((entry) => entry.usage.length));
  return [
    line('Supported workbench commands (no host shell is available):', 'muted'),
    ...COMMAND_HELP.map((entry) => line(`  ${entry.usage.padEnd(width)}   ${entry.description}`)),
  ];
}

function probeFailure(session, operation) {
  const probe = session.probes.find((item) => item.operationId === operation.id);
  if (probe?.error?.includes('ECONNREFUSED')) {
    return `curl: (7) Failed to connect to ${probe.serviceId} port ${probe.port}: Connection refused`;
  }
  if (probe?.statusCode) {
    return `curl: (22) The requested URL returned error: ${probe.statusCode}`;
  }
  return `curl: ${operation.error?.message ?? 'probe failed'}`;
}

function successOutput(view, operation, session) {
  const result = operation.result;
  switch (view) {
    case 'docker.start':
    case 'docker.stop':
    case 'docker.restart':
      return [line(operation.parameters.serviceId, 'success')];
    case 'docker.inspect':
      return JSON.stringify(result, null, 2).split('\n').map((text) => line(text));
    case 'docker.logs': {
      if (!result.count) {
        return [line('(no log output)', 'muted')];
      }
      const entries = session.logs.entries.filter((entry) => entry.serviceId === result.serviceId &&
        entry.seq >= result.firstSeq && entry.seq <= result.lastSeq);
      return [
        ...(result.truncated ? [line('[older entries were discarded by the retention limit]', 'muted')] : []),
        ...entries.map((entry) => line(entry.message, entry.stream === 'stderr' ? 'error' : 'default')),
      ];
    }
    case 'curl/health':
    case 'curl/version':
      return [line(JSON.stringify(result.body))];
    default:
      return [line(`${describeOperation(operation)} ${operation.status}.`, 'success')];
  }
}

function failureOutput(view, operation, session) {
  if (view.startsWith('curl/')) {
    return [line(probeFailure(session, operation), 'error')];
  }
  if (operation.status === 'cancelled') {
    return [line(`${describeOperation(operation)} was cancelled.`, 'warning')];
  }
  return [line(`Error: ${operation.error?.message ?? 'The operation failed.'}`, 'error')];
}

/**
 * Execute one terminal line. Operations go through the same session client
 * as the workbench buttons, so both paths share validation and effects.
 * Returns { lines, clear } and never throws for user input.
 */
export async function runTerminalCommand(input, { client, requestLifecycle }) {
  const { session } = client.getSnapshot();
  if (!session) {
    return { lines: [line('The session is not ready yet.', 'error')] };
  }
  const parsed = parseCommand(input, commandContext(session));
  switch (parsed.kind) {
    case 'empty':
      return { lines: [] };
    case 'error':
      return { lines: [line(parsed.message, 'error'), line(parsed.hint, 'muted')] };
    case 'local':
      if (parsed.action === 'clear') {
        return { lines: [], clear: true };
      }
      if (parsed.action === 'help') {
        return { lines: help() };
      }
      if (parsed.action === 'docker.ps') {
        return { lines: dockerPs(session) };
      }
      return { lines: labStatus(session, client.mode) };
    case 'confirm': {
      const operation = await new Promise((resolve) => {
        requestLifecycle(parsed.type, { onSettled: resolve });
      });
      if (!operation) {
        return { lines: [line('Reset cancelled.', 'muted')] };
      }
      const settled = await client.settled(operation.id);
      return settled.status === 'succeeded'
        ? { lines: [line(`Session reset to generation ${settled.result.generation}.`, 'success')] }
        : { lines: [line(`Error: ${settled.error?.message ?? 'Reset failed.'}`, 'error')] };
    }
    default: {
      let operation;
      try {
        operation = await client.dispatch({ ...parsed.request, generation: session.generation });
      } catch (error) {
        return { lines: [line(`Error: ${error.message}`, 'error')] };
      }
      const settled = await client.settled(operation.id);
      const latest = client.getSnapshot().session;
      return {
        lines: settled.status === 'succeeded'
          ? successOutput(parsed.view, settled, latest)
          : failureOutput(parsed.view, settled, latest),
      };
    }
  }
}

const TONES = { default: '', muted: '\x1b[90m', success: '\x1b[32m', warning: '\x1b[33m', error: '\x1b[31m' };

/** Render sanitized output lines with the terminal's own color codes. */
export function formatLines(lines) {
  return lines.map(({ text, tone }) => {
    const safe = sanitizeTerminalText(text);
    return TONES[tone] ? `${TONES[tone]}${safe}\x1b[0m` : safe;
  });
}
