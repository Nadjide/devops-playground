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
    ...(session.storage ? [line(
      `Storage    ${session.storage.provider} at ${session.storage.endpoint}, ${session.storage.namespaces.length} namespace(s), ${session.storage.objects.length} object(s)`)] : []),
  ];
}

function help(session) {
  const provider = session.storage?.provider ?? null;
  // Storage commands are listed only where the lab has that provider.
  const entries = COMMAND_HELP.filter((entry) => (!entry.storage || provider) && (!entry.provider || entry.provider === provider));
  const width = Math.max(...entries.map((entry) => entry.usage.length));
  return [
    line('Supported workbench commands (no host shell is available):', 'muted'),
    ...entries.map((entry) => line(`  ${entry.usage.padEnd(width)}   ${entry.description}`)),
  ];
}

const listingTime = (iso) => iso.slice(0, 19).replace('T', ' ');

function storageOutput(view, result) {
  switch (view) {
    case 'aws.s3.ls':
      return result.namespaces.length
        ? result.namespaces.map((item) => line(`${item.name}${item.owned ? '' : '   (not owned by this lab)'}`))
        : [line('(no buckets)', 'muted')];
    case 'aws.s3.ls-objects':
      return result.objects.length
        ? result.objects.map((item) => line(`${listingTime(item.updatedAt)} ${String(item.bytes).padStart(10)} ${item.key}`))
        : [line('(no objects)', 'muted')];
    case 'aws.s3.mb':
      return [line(`make_bucket: ${result.namespace}`, 'success')];
    case 'aws.s3.rm':
      return [line(`delete: s3://${result.namespace}/${result.key}`, 'success')];
    case 'aws.s3.cp':
    case 'az.blob.download':
      return [
        ...result.content.split('\n').map((text) => line(text)),
        ...(result.truncated ? [line(`[preview shows the first 4 KiB of ${result.bytes} bytes]`, 'muted')] : []),
      ];
    case 'az.container.list':
      return result.namespaces.length
        ? table([['Name', 'Owned by lab'], ...result.namespaces.map((item) => [item.name, item.owned ? 'yes' : 'no'])])
          .map((text, index) => line(text, index === 0 ? 'muted' : 'default'))
        : [line('[]', 'muted')];
    case 'az.container.create':
      return [line('{ "created": true }', 'success')];
    case 'az.blob.list':
      return result.objects.length
        ? table([['Name', 'Length', 'Last modified'], ...result.objects.map((item) => [item.key, String(item.bytes), item.updatedAt.slice(0, 19)])])
          .map((text, index) => line(text, index === 0 ? 'muted' : 'default'))
        : [line('[]', 'muted')];
    case 'az.blob.delete':
      return [line(`Deleted blob ${result.key}`, 'success')];
    case 'curl/storage-check':
      return [line(JSON.stringify({ ok: true, namespace: result.namespace, key: result.key, bytes: result.bytes, sha256: result.sha256 }))];
    default:
      return null;
  }
}

function storageCheckFailure(session, operation) {
  if (operation.error?.code === 'WORKLOAD_UNREACHABLE') {
    const resource = session.resources.find((item) => item.serviceId === operation.parameters.serviceId);
    return [line(`curl: (7) Failed to connect to ${operation.parameters.serviceId} port ${resource?.desired.expectedProbePort}: Connection refused`, 'error')];
  }
  const check = session.storage?.roundTrips.findLast((item) => item.operationId === operation.id);
  if (check) {
    return [
      line(JSON.stringify({ ok: false, namespace: check.namespace, key: check.key, error: check.error })),
      line(`curl: (22) The requested URL returned error: ${check.statusCode}`, 'error'),
    ];
  }
  return [line(`curl: ${operation.error?.message ?? 'storage check failed'}`, 'error')];
}

function probeFailure(session, operation) {
  const probe = session.probes.find((item) => item.operationId === operation.id);
  if (probe?.error?.includes('ENOTFOUND') || probe?.error?.includes('EAI_AGAIN')) {
    return `curl: (6) Could not resolve host: ${probe.serviceId}`;
  }
  if (probe?.error?.includes('is not running')) {
    return `curl: (7) Failed to connect to ${probe.serviceId} port ${probe.port}: Couldn't connect to server`;
  }
  if (probe?.error?.includes('ECONNREFUSED')) {
    return `curl: (7) Failed to connect to ${probe.serviceId} port ${probe.port}: Connection refused`;
  }
  if (probe?.statusCode) {
    return `curl: (22) The requested URL returned error: ${probe.statusCode}`;
  }
  return `curl: ${operation.error?.message ?? 'probe failed'}`;
}

function pipelineSummary(operation, session) {
  const run = session.pipeline.runs.find((item) => item.id === operation.id);
  if (!run) {
    return [];
  }
  const stageLines = run.stages.map((stage) => line(
    `  ${stage.id.padEnd(9)} ${stage.status}${stage.durationMs !== null ? ` (${stage.durationMs} ms)` : ''}`,
    { passed: 'success', failed: 'error', cancelled: 'warning' }[stage.status] ?? 'muted',
  ));
  const deployed = session.pipeline.deployed;
  return [
    line(`${run.kind === 'rollback' ? 'Rollback' : 'Pipeline'} for release ${run.release.version}: ${run.status}`),
    ...stageLines,
    ...(run.failureReason ? [line(run.failureReason, 'error')] : []),
    ...(deployed ? [line(`Deployed: ${deployed.version} (${deployed.status})`, 'muted')] : []),
  ];
}

function successOutput(view, operation, session) {
  const result = operation.result;
  if (view === 'pipeline.run' || view === 'pipeline.rollback') {
    return pipelineSummary(operation, session);
  }
  const storage = storageOutput(view, result);
  if (storage) {
    return storage;
  }
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
  if (view === 'curl/storage-check') {
    return storageCheckFailure(session, operation);
  }
  if (view.startsWith('curl/')) {
    return [line(probeFailure(session, operation), 'error')];
  }
  if ((view === 'pipeline.run' || view === 'pipeline.rollback') && session.pipeline.runs.some((run) => run.id === operation.id)) {
    return pipelineSummary(operation, session);
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
        return { lines: help(session) };
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
