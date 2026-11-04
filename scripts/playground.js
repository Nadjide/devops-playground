#!/usr/bin/env node
/**
 * Cross-platform launcher for the interactive playground.
 *
 *   node scripts/playground.js demo     Portal only (browser simulation, no runner, no socket)
 *   node scripts/playground.js local    Portal and runner (real local Docker)
 *   node scripts/playground.js status   Mode, controller, runner, Docker, owned resources
 *   node scripts/playground.js down     End sessions, stop the stack, report owned leftovers
 *   node scripts/playground.js cleanup  Remove resources owned by this installation only
 *
 * PLAYGROUND_PORT selects the loopback portal port (default 3001).
 * The runner token is generated per launch and only passed through the
 * process environment of `docker compose`; it is never printed or written.
 */
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const COMPOSE_FILE = path.join(ROOT, 'compose.playground.yml');
const OWNED_LABEL = 'devops-playground.managed=true';

function fail(message, hint) {
  console.error(`✖ ${message}`);
  if (hint) {
    console.error(`  ${hint}`);
  }
  process.exit(1);
}

function portFromEnv() {
  const raw = process.env.PLAYGROUND_PORT ?? '3001';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    fail(`PLAYGROUND_PORT must be an integer from 1024 to 65535 (received "${raw}").`);
  }
  return port;
}

function run(command, args, { env = process.env, capture = false } = {}) {
  return spawnSync(command, args, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: false,
    windowsHide: true,
  });
}

function requireDocker() {
  const version = run('docker', ['version', '--format', '{{.Server.Version}}'], { capture: true });
  if (version.error) {
    fail('The Docker CLI was not found.', 'Install Docker Desktop or Docker Engine with the Compose plugin.');
  }
  if (version.status !== 0) {
    fail('The Docker daemon is unavailable.', 'Start Docker Desktop or Docker Engine, then run this command again.');
  }
  const compose = run('docker', ['compose', 'version', '--short'], { capture: true });
  if (compose.status !== 0) {
    fail('The docker compose plugin is unavailable.', 'Install Docker Compose v2 (the "docker compose" plugin).');
  }
  return { engine: version.stdout.trim(), compose: compose.stdout.trim() };
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

function portalIsOurs(port) {
  const result = run('docker', ['compose', '-f', COMPOSE_FILE, 'ps', '--status', 'running', '--services'], { capture: true });
  return result.status === 0 && result.stdout.split('\n').includes('control') && Boolean(port);
}

/** Group that owns the daemon socket inside containers, for the runner's group_add. */
function socketGroup() {
  const result = run('docker', ['run', '--rm', '--network', 'none', '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '--entrypoint', 'stat', 'node:22-alpine', '-c', '%g', '/var/run/docker.sock'], { capture: true });
  const gid = result.stdout?.trim();
  if (result.status !== 0 || !/^\d+$/.test(gid ?? '')) {
    fail('Could not inspect the Docker socket.', 'The local lab needs /var/run/docker.sock; rootless or remote contexts are not supported yet.');
  }
  return gid;
}

function compose(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  return run('docker', ['compose', '-f', COMPOSE_FILE, ...args], { env });
}

/** This installation's identity, read from its volume; it scopes every cleanup. */
function installationId() {
  const result = run('docker', ['run', '--rm', '--network', 'none', '-v', 'devops-playground_installation:/data:ro',
    '--entrypoint', 'cat', 'node:22-alpine', '/data/installation.json'], { capture: true });
  try {
    const id = JSON.parse(result.stdout).id;
    return /^[a-f0-9-]{36}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function ownedResources(installation = installationId()) {
  const filters = ['--filter', `label=${OWNED_LABEL}`, ...(installation ? ['--filter', `label=devops-playground.installation=${installation}`] : [])];
  const containers = run('docker', ['ps', '-a', ...filters, '--format', '{{.Names}} ({{.Status}})'], { capture: true });
  const networks = run('docker', ['network', 'ls', ...filters, '--format', '{{.Name}}'], { capture: true });
  const lines = (result) => (result.status === 0 ? result.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : []);
  return { containers: lines(containers), networks: lines(networks) };
}

async function up(mode) {
  const versions = requireDocker();
  const port = portFromEnv();
  if (!(await portIsFree(port)) && !portalIsOurs(port)) {
    fail(`Port ${port} on 127.0.0.1 is already in use.`, 'Stop the other process or set PLAYGROUND_PORT to a free port.');
  }
  const env = {
    PLAYGROUND_MODE: mode,
    PLAYGROUND_PORT: String(port),
    PLAYGROUND_RUNNER_TOKEN: mode === 'local' ? randomBytes(32).toString('base64url') : '',
    PLAYGROUND_DOCKER_GID: mode === 'local' ? socketGroup() : '0',
  };
  console.log(`Starting the playground in ${mode === 'local' ? 'Local Docker' : 'Demo'} mode (Docker ${versions.engine}, Compose ${versions.compose})...`);
  const args = [...(mode === 'local' ? ['--profile', 'local'] : []), 'up', '--detach', '--build', '--remove-orphans', '--wait', '--wait-timeout', '240'];
  if (mode === 'demo') {
    // A previous local launch may have left the runner running; demo mode never keeps it.
    compose(['--profile', 'local', 'stop', 'runner']);
    compose(['--profile', 'local', 'rm', '--force', 'runner']);
  }
  const result = compose(args, env);
  if (result.status !== 0) {
    fail('docker compose could not start the playground.', 'Run "npm run playground:status" and check "docker compose -f compose.playground.yml logs".');
  }
  console.log(`✔ Workbench ready at http://127.0.0.1:${port}`);
}

async function status() {
  const port = portFromEnv();
  const base = `http://127.0.0.1:${port}`;
  const get = async (route) => {
    try {
      const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(5000) });
      return { ok: response.ok, body: await response.json() };
    } catch {
      return { ok: false, body: null };
    }
  };
  const health = await get('/health');
  if (!health.ok) {
    console.log(`Controller: not reachable at ${base}`);
  } else {
    const capabilities = await get('/api/capabilities');
    const runner = capabilities.body?.runner?.status ?? 'unknown';
    const docker = capabilities.body?.docker;
    console.log(`Controller: healthy (${health.body.mode} mode) at ${base}`);
    console.log(`Runner:     ${runner}`);
    console.log(`Docker:     ${docker ? (docker.available ? `available (Engine ${docker.serverVersion})` : `unavailable (${docker.error?.code})`) : 'not used in Demo mode'}`);
  }
  const owned = ownedResources();
  console.log(`Owned lab containers: ${owned.containers.length ? owned.containers.join(', ') : 'none'}`);
  console.log(`Owned lab networks:   ${owned.networks.length ? owned.networks.join(', ') : 'none'}`);
}

function down() {
  requireDocker();
  const result = compose(['--profile', 'local', 'down', '--remove-orphans']);
  const owned = ownedResources();
  if (result.status !== 0) {
    fail('docker compose could not stop the playground stack.');
  }
  console.log('✔ Playground stack stopped.');
  if (owned.containers.length || owned.networks.length) {
    console.log('Owned lab resources remain (no global cleanup was performed):');
    for (const name of [...owned.containers, ...owned.networks]) {
      console.log(`  - ${name}`);
    }
    console.log('Run "npm run playground:cleanup" to remove only these resources.');
  } else {
    console.log('No owned lab resources remain.');
  }
}

/** Remove containers and networks labeled with this installation, nothing else. */
function cleanup() {
  requireDocker();
  const installation = installationId();
  if (!installation) {
    fail('No installation identity was found.', 'Nothing was removed: without the identity, ownership cannot be proven.');
  }
  const filter = ['--filter', `label=${OWNED_LABEL}`, '--filter', `label=devops-playground.installation=${installation}`];
  const ids = (args) => run('docker', args, { capture: true }).stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const containers = ids(['ps', '-aq', ...filter]);
  if (containers.length) {
    run('docker', ['rm', '--force', ...containers], { capture: true });
  }
  const networks = ids(['network', 'ls', '-q', ...filter]);
  for (const network of networks) {
    // The runner joins lab networks to probe them; detach every endpoint before removal.
    const endpoints = ids(['network', 'inspect', network, '--format', '{{range $id, $c := .Containers}}{{$id}}\n{{end}}']);
    for (const endpoint of endpoints) {
      run('docker', ['network', 'disconnect', '--force', network, endpoint], { capture: true });
    }
  }
  if (networks.length) {
    run('docker', ['network', 'rm', ...networks], { capture: true });
  }
  const owned = ownedResources(installation);
  console.log(`Removed ${containers.length} container(s) and ${networks.length} network(s) owned by installation ${installation.slice(0, 8)}.`);
  if (owned.containers.length || owned.networks.length) {
    fail(`Some owned resources remain: ${[...owned.containers, ...owned.networks].join(', ')}`);
  }
}

const command = process.argv[2];
const commands = { demo: () => up('demo'), local: () => up('local'), status, down, cleanup };
if (!commands[command]) {
  fail('Usage: node scripts/playground.js <demo|local|status|down|cleanup>');
}
Promise.resolve(commands[command]()).catch((error) => fail(error.message));
