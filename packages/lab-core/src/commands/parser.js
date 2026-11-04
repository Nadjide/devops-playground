import { parse } from 'shell-quote';
import { getFixture } from '../fixtures/catalog.js';

export const MAX_COMMAND_LENGTH = 512;
export const TAIL_LIMITS = Object.freeze({ min: 1, max: 200, default: 50 });

export const COMMAND_HELP = Object.freeze([
  { usage: 'help', description: 'List supported commands' },
  { usage: 'clear', description: 'Clear the terminal view (event history is kept)' },
  { usage: 'lab status', description: 'Show session, mission, and service status' },
  { usage: 'lab reset', description: 'Reset the session after confirmation' },
  { usage: 'docker ps', description: 'List session containers' },
  { usage: 'docker inspect <service>', description: 'Show approved configuration and observed state' },
  { usage: 'docker logs <service> [--tail N]', description: 'Read recent logs (N from 1 to 200, default 50)' },
  { usage: 'docker start|stop|restart <service>', description: 'Change the container lifecycle' },
  { usage: 'curl http://<service>:<port>/health', description: 'Probe the health endpoint' },
  { usage: 'curl http://<service>:<port>/version', description: 'Probe the version endpoint' },
  { usage: 'pipeline run', description: 'Run the delivery pipeline for the lab candidate' },
  { usage: 'pipeline rollback', description: 'Roll back to the last known-good release' },
  { usage: 'curl http://<service>:<port>/storage-check', description: 'Run the service storage round trip (storage labs)', storage: true },
  { usage: 'aws s3 ls [s3://<bucket>]', description: 'List buckets, or the objects of one bucket', provider: 'aws-s3' },
  { usage: 'aws s3 mb s3://<bucket>', description: 'Create a bucket', provider: 'aws-s3' },
  { usage: 'aws s3 cp s3://<bucket>/<key> -', description: 'Print an object (writes use the Cloud panel)', provider: 'aws-s3' },
  { usage: 'aws s3 rm s3://<bucket>/<key>', description: 'Delete an object', provider: 'aws-s3' },
  { usage: 'az storage container list', description: 'List containers', provider: 'azure-blob' },
  { usage: 'az storage container create -n <container>', description: 'Create a container', provider: 'azure-blob' },
  { usage: 'az storage blob list -c <container>', description: 'List the blobs of a container', provider: 'azure-blob' },
  { usage: 'az storage blob download -c <container> -n <blob>', description: 'Print a blob (uploads use the Cloud panel)', provider: 'azure-blob' },
  { usage: 'az storage blob delete -c <container> -n <blob>', description: 'Delete a blob', provider: 'azure-blob' },
]);

const AZ_CONNECTION_FLAGS = ['--connection-string', '--account-name', '--account-key', '--sas-token', '--blob-endpoint', '--auth-mode', '--blob-url'];
const AZ_FLAGS = { '--container-name': 'container', '-c': 'container', '--name': 'name', '-n': 'name' };

const S3_BUCKET_URI = /^s3:\/\/([A-Za-z0-9._-]{1,63})\/?$/;
const S3_OBJECT_URI = /^s3:\/\/([A-Za-z0-9._-]{1,63})\/(.+)$/;
const OBJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// Shell metacharacters have no meaning here; rejecting them keeps parsing literal.
const FORBIDDEN = /[|&;<>()$`\\*?~{}[\]#!]/;
// eslint-disable-next-line no-control-regex -- rejects control characters in commands.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const HINT = 'Type help to list supported commands.';

function reject(message, hint = HINT) {
  return { kind: 'error', message, hint };
}

function operation(type, parameters, view) {
  return { kind: 'operation', request: { type, parameters }, view };
}

function tokenize(input) {
  if (typeof input !== 'string') {
    return reject('Commands must be text.');
  }
  if (input.length > MAX_COMMAND_LENGTH) {
    return reject(`Commands are limited to ${MAX_COMMAND_LENGTH} characters.`);
  }
  if (/[\r\n]/.test(input)) {
    return reject('Multiline input is not supported. Enter one command at a time.');
  }
  if (CONTROL.test(input)) {
    return reject('Control characters are not supported.');
  }
  const forbidden = input.match(FORBIDDEN);
  if (forbidden) {
    return reject(`Shell operators, redirects, substitutions, and globs are not supported ('${forbidden[0]}').`);
  }
  let tokens;
  try {
    tokens = parse(input);
  } catch {
    return reject('The command could not be parsed. Check its quotes.');
  }
  if (tokens.some((token) => typeof token !== 'string')) {
    return reject('Shell operators, redirects, substitutions, and globs are not supported.');
  }
  if (tokens.length > 0 && ASSIGNMENT.test(tokens[0])) {
    return reject('Environment assignments are not supported.');
  }
  return { kind: 'tokens', tokens };
}

function resolveService(name, context) {
  if (!context.services.includes(name)) {
    return reject(`Unknown service '${name}'. Services in this lab: ${context.services.join(', ') || 'none'}.`, 'Run docker ps to list containers.');
  }
  return null;
}

function parseDocker(args, context) {
  const [subcommand, ...rest] = args;
  if (subcommand === 'ps') {
    return rest.length === 0 ? { kind: 'local', action: 'docker.ps' } : reject(`Unsupported option '${rest[0]}' for docker ps.`);
  }
  const simple = { inspect: 'container.inspect', start: 'container.start', stop: 'container.stop', restart: 'container.restart' };
  if (subcommand in simple) {
    const flag = rest.find((token) => token.startsWith('-'));
    if (flag) {
      return reject(`Unknown flag '${flag}' for docker ${subcommand}.`);
    }
    if (rest.length !== 1) {
      return reject(`Usage: docker ${subcommand} <service>`);
    }
    return resolveService(rest[0], context) ??
      operation(simple[subcommand], { serviceId: rest[0] }, `docker.${subcommand}`);
  }
  if (subcommand === 'logs') {
    let tail = TAIL_LIMITS.default;
    const positional = [];
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === '--tail' || token === '-n' || token.startsWith('--tail=')) {
        const value = token.startsWith('--tail=') ? token.slice(7) : rest[(index += 1)];
        if (!/^\d{1,3}$/.test(value ?? '') || Number(value) < TAIL_LIMITS.min || Number(value) > TAIL_LIMITS.max) {
          return reject(`--tail accepts an integer from ${TAIL_LIMITS.min} to ${TAIL_LIMITS.max}.`);
        }
        tail = Number(value);
      } else if (token.startsWith('-')) {
        return reject(`Unknown flag '${token}' for docker logs.`);
      } else {
        positional.push(token);
      }
    }
    if (positional.length !== 1) {
      return reject('Usage: docker logs <service> [--tail N]');
    }
    return resolveService(positional[0], context) ??
      operation('container.logs', { serviceId: positional[0], tail }, 'docker.logs');
  }
  return reject(subcommand ? `Unsupported docker command '${subcommand}'.` : 'Usage: docker <ps|inspect|logs|start|stop|restart>');
}

function parseCurl(args, context) {
  const flag = args.find((token) => token.startsWith('-'));
  if (flag) {
    return reject(`curl options such as '${flag}' are not supported.`);
  }
  if (args.length !== 1) {
    return reject('Usage: curl http://<service>:<port>/health');
  }
  const allowed = context.storageProvider
    ? 'curl only reaches the lab service health, version, and storage-check endpoints.'
    : 'curl only reaches the lab service health and version endpoints.';
  const match = /^http:\/\/([a-z][a-z0-9-]{0,62}):(\d{2,5})(\/health|\/version|\/storage-check)$/.exec(args[0]);
  if (match?.[3] === '/storage-check' && !context.storageProvider) {
    return reject(`This lab has no storage-capable service. ${allowed}`);
  }
  if (!match) {
    return reject(`Unsupported URL. ${allowed}`, `Try curl http://${context.services[0] ?? 'api'}:${context.probePorts[context.services[0]] ?? 3000}/health`);
  }
  const [, serviceId, port, path] = match;
  const unknown = resolveService(serviceId, context);
  if (unknown) {
    return unknown;
  }
  if (Number(port) !== context.probePorts[serviceId]) {
    return reject(`Port ${port} is not an approved probe port for ${serviceId}. ${allowed}`,
      `The lab probes ${serviceId} on port ${context.probePorts[serviceId]}.`);
  }
  const type = { '/health': 'health.probe', '/version': 'version.probe', '/storage-check': 'storage.roundtrip.verify' }[path];
  return operation(type, { serviceId }, `curl${path}`);
}

function parseObjectUri(uri, usage) {
  const match = S3_OBJECT_URI.exec(uri ?? '');
  if (!match) {
    return reject(`Usage: ${usage}`);
  }
  if (!OBJECT_KEY.test(match[2]) || match[2].includes('..')) {
    return reject('Object keys are 1 to 128 letters, digits, dots, hyphens, or underscores; paths and slashes are not supported.');
  }
  return { namespace: match[1], key: match[2] };
}

/** The AWS CLI subset the S3 labs support; the endpoint is always the session emulator. */
function parseAws(args, context) {
  if (context.storageProvider !== 'aws-s3') {
    return reject('This lab has no AWS S3 storage.', 'Choose a storage mission to use aws s3 commands.');
  }
  const [service, subcommand, ...rest] = args;
  const flag = rest.find((token) => token.startsWith('--'));
  if (flag) {
    return reject(`Options such as '${flag}' are not supported; the lab always uses its session emulator.`);
  }
  if (service !== 's3') {
    return reject('Only aws s3 ls, mb, cp, and rm are supported.');
  }
  if (subcommand === 'ls') {
    if (rest.length === 0) {
      return operation('storage.namespace.list', {}, 'aws.s3.ls');
    }
    const bucket = rest.length === 1 && S3_BUCKET_URI.exec(rest[0]);
    return bucket
      ? operation('storage.object.list', { namespace: bucket[1] }, 'aws.s3.ls-objects')
      : reject('Usage: aws s3 ls [s3://<bucket>]');
  }
  if (subcommand === 'mb') {
    const bucket = rest.length === 1 && S3_BUCKET_URI.exec(rest[0]);
    return bucket ? operation('storage.namespace.create', { namespace: bucket[1] }, 'aws.s3.mb') : reject('Usage: aws s3 mb s3://<bucket>');
  }
  if (subcommand === 'rb') {
    return reject('Delete buckets from the Cloud panel, which asks for confirmation first.');
  }
  if (subcommand === 'cp') {
    if (rest.length !== 2 || rest[1] !== '-') {
      return reject('Only aws s3 cp s3://<bucket>/<key> - is supported. The workbench has no file system; write objects from the Cloud panel.');
    }
    const target = parseObjectUri(rest[0], 'aws s3 cp s3://<bucket>/<key> -');
    return target.kind === 'error' ? target : operation('storage.object.get', target, 'aws.s3.cp');
  }
  if (subcommand === 'rm') {
    const target = rest.length === 1 ? parseObjectUri(rest[0], 'aws s3 rm s3://<bucket>/<key>') : reject('Usage: aws s3 rm s3://<bucket>/<key>');
    return target.kind === 'error' ? target : operation('storage.object.delete', target, 'aws.s3.rm');
  }
  return reject(subcommand ? `Unsupported aws s3 command '${subcommand.slice(0, 40)}'.` : 'Usage: aws s3 <ls|mb|cp|rm>');
}

/** Named arguments of the az subset; connection settings are never accepted. */
function azArguments(tokens) {
  const values = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const flag = token.split('=')[0];
    if (AZ_CONNECTION_FLAGS.includes(flag)) {
      return reject(`Connection options such as '${flag}' are not supported; the lab always uses its session emulator.`);
    }
    const field = AZ_FLAGS[flag];
    if (!field) {
      return reject(token.startsWith('-') ? `Unknown argument '${token.slice(0, 40)}'.` : `Unexpected value '${token.slice(0, 40)}'.`);
    }
    const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : tokens[(index += 1)];
    if (!value || value.startsWith('-')) {
      return reject(`${flag} needs a value.`);
    }
    values[field] = value;
  }
  return { kind: 'arguments', values };
}

/** The Azure CLI subset the Blob labs support; the endpoint is always the session emulator. */
function parseAz(args, context) {
  if (context.storageProvider !== 'azure-blob') {
    return reject('This lab has no Azure Blob storage.', 'Choose an Azure storage mission to use az storage commands.');
  }
  const [service, resource, action, ...rest] = args;
  if (service !== 'storage' || !['container', 'blob'].includes(resource)) {
    return reject('Only az storage container and az storage blob commands are supported.');
  }
  const parsed = azArguments(rest);
  if (parsed.kind === 'error') {
    return parsed;
  }
  const { container, name } = parsed.values;
  const blobKey = () => (OBJECT_KEY.test(name ?? '') && !name.includes('..')
    ? null
    : reject('Blob names are 1 to 128 letters, digits, dots, hyphens, or underscores; paths and slashes are not supported.'));
  if (resource === 'container') {
    if (action === 'list') {
      return Object.keys(parsed.values).length === 0
        ? operation('storage.namespace.list', {}, 'az.container.list')
        : reject('Usage: az storage container list');
    }
    if (action === 'create') {
      return name && !container ? operation('storage.namespace.create', { namespace: name }, 'az.container.create') : reject('Usage: az storage container create -n <container>');
    }
    if (action === 'delete') {
      return reject('Delete containers from the Cloud panel, which asks for confirmation first.');
    }
    return reject('Usage: az storage container <list|create>');
  }
  if (action === 'upload') {
    return reject('The workbench has no file system; upload blobs from the Cloud panel.');
  }
  if (action === 'list') {
    return container && !name ? operation('storage.object.list', { namespace: container }, 'az.blob.list') : reject('Usage: az storage blob list -c <container>');
  }
  if (action === 'download' || action === 'delete') {
    if (!container || !name) {
      return reject(`Usage: az storage blob ${action} -c <container> -n <blob>`);
    }
    return blobKey() ?? operation(action === 'download' ? 'storage.object.get' : 'storage.object.delete',
      { namespace: container, key: name }, `az.blob.${action}`);
  }
  return reject('Usage: az storage blob <list|download|delete>');
}

/**
 * Translate one terminal line into a local action, a confirmation request, or
 * a typed operation request. Nothing here executes; callers dispatch the result
 * through the same session client the buttons use.
 *
 * context: { services: string[], probePorts: { [serviceId]: number }, candidateReleaseId?: string }
 */
export function parseCommand(input, context) {
  const tokenized = tokenize(input);
  if (tokenized.kind === 'error') {
    return tokenized;
  }
  const [command, ...args] = tokenized.tokens;
  if (command === undefined) {
    return { kind: 'empty' };
  }
  switch (command) {
    case 'help':
      return args.length === 0 ? { kind: 'local', action: 'help' } : reject('help takes no arguments.');
    case 'clear':
      return args.length === 0 ? { kind: 'local', action: 'clear' } : reject('clear takes no arguments.');
    case 'lab':
      if (args.length === 1 && args[0] === 'status') {
        return { kind: 'local', action: 'lab.status' };
      }
      if (args.length === 1 && args[0] === 'reset') {
        return { kind: 'confirm', type: 'session.reset' };
      }
      return reject('Usage: lab status | lab reset');
    case 'docker':
      return parseDocker(args, context);
    case 'curl':
      return parseCurl(args, context);
    case 'aws':
      return parseAws(args, context);
    case 'az':
      return parseAz(args, context);
    case 'pipeline':
      if (args.length === 1 && args[0] === 'run') {
        if (!context.candidateReleaseId) {
          return reject('This lab has no pipeline candidate.');
        }
        return operation('pipeline.run', { releaseId: context.candidateReleaseId }, 'pipeline.run');
      }
      if (args.length === 1 && args[0] === 'rollback') {
        return operation('pipeline.rollback', {}, 'pipeline.rollback');
      }
      return reject('Usage: pipeline run | pipeline rollback');
    default:
      return reject(`Unknown command '${command.slice(0, 40)}'.`);
  }
}

export function commandContext(session) {
  return {
    candidateReleaseId: getFixture(session.fixtureId).candidates?.[0],
    storageProvider: session.storage?.provider ?? null,
    services: session.resources.map((resource) => resource.serviceId),
    probePorts: Object.fromEntries(session.resources.map((resource) => [resource.serviceId, resource.desired.expectedProbePort])),
  };
}
