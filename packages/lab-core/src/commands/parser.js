import { parse } from 'shell-quote';

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
]);

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
  const allowed = 'curl only reaches the lab service health and version endpoints.';
  const match = /^http:\/\/([a-z][a-z0-9-]{0,62}):(\d{2,5})(\/health|\/version)$/.exec(args[0]);
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
  return operation(path === '/health' ? 'health.probe' : 'version.probe', { serviceId }, `curl${path}`);
}

/**
 * Translate one terminal line into a local action, a confirmation request, or
 * a typed operation request. Nothing here executes; callers dispatch the result
 * through the same session client the buttons use.
 *
 * context: { services: string[], probePorts: { [serviceId]: number }, fixtureId?: string }
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
    case 'pipeline':
      if (args.length === 1 && args[0] === 'run') {
        return operation('pipeline.run', { fixtureId: context.candidateFixtureId ?? 'api-candidate' }, 'pipeline.run');
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
    services: session.resources.map((resource) => resource.serviceId),
    probePorts: Object.fromEntries(session.resources.map((resource) => [resource.serviceId, resource.desired.expectedProbePort])),
  };
}
