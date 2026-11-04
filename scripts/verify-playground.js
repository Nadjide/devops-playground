#!/usr/bin/env node
/**
 * Run the core release gates and print an acceptance report.
 *
 *   npm run verify:playground              all gates; Docker is required
 *   npm run verify:playground -- --demo    Phase A gates only (no Docker)
 *
 * Missing infrastructure is reported as a failed prerequisite, never as a pass.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const demoOnly = process.argv.includes('--demo');
const results = [];

function step(name, command, args, { phase }) {
  const started = Date.now();
  console.log(`\n▶ ${name}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' && command === 'npm' });
  const ok = result.status === 0;
  results.push({ name, phase, status: ok ? 'passed' : 'failed', seconds: Math.round((Date.now() - started) / 1000) });
  return ok;
}

const npm = (name, script, phase) => step(name, 'npm', ['run', script], { phase });

npm('Lint', 'lint', 'Core');
npm('Original API tests', 'test:ci', 'Core');
npm('Playground unit and API tests', 'test:playground', 'A/B');
step('Secret scan of tracked files', process.execPath, ['scripts/scan-secrets.js'], { phase: 'Core' });
npm('Production workbench build', 'build:playground', 'A');
npm('Simulated demo browser suite', 'test:e2e:demo', 'A');

if (!demoOnly) {
  const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  if (docker.status !== 0) {
    results.push({ name: 'Docker prerequisite', phase: 'B', status: 'failed (Docker daemon unavailable)', seconds: 0 });
  } else {
    step('Standalone workload image', 'docker', ['build', '-q', '-t', 'devops-playground', '.'], { phase: 'Core' });
    step('Playground Compose configuration', 'docker', ['compose', '-f', 'compose.playground.yml', '--profile', 'local', 'config', '--quiet'], { phase: 'B' });
    step('Packaged Demo mode start', process.execPath, ['scripts/playground.js', 'demo'], { phase: 'B' });
    step('Demo stack boundaries', process.execPath, ['scripts/check-playground-stack.js', 'demo'], { phase: 'B' });
    step('Packaged Local mode start', process.execPath, ['scripts/playground.js', 'local'], { phase: 'B' });
    step('Local stack boundaries', process.execPath, ['scripts/check-playground-stack.js', 'local'], { phase: 'B' });
    npm('Real Docker integration', 'test:integration:local', 'B');
    npm('Local Docker browser suite', 'test:e2e:local', 'B');
    step('Stop playground', process.execPath, ['scripts/playground.js', 'down'], { phase: 'B' });
  }
}

console.log('\nCore acceptance report');
console.log('| Gate | Phase | Result | Seconds |');
console.log('| --- | --- | --- | --- |');
for (const result of results) {
  console.log(`| ${result.name} | ${result.phase} | ${result.status} | ${result.seconds} |`);
}
const failed = results.filter((result) => result.status !== 'passed');
if (demoOnly) {
  console.log('\nPhase B gates were not run (--demo); this report does not establish Local Docker readiness.');
}
process.exit(failed.length ? 1 : 0);
