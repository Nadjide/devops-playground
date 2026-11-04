#!/usr/bin/env node
/**
 * Run the Local Docker browser suite against the packaged portal:
 * start the local stack, run Playwright's `local` project, always stop the stack.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const env = { ...process.env, PLAYGROUND_E2E_LOCAL: '1' };
const run = (command, args) => spawnSync(command, args, { cwd: root, env, stdio: 'inherit', shell: false }).status;
const playwright = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');

let status = run(process.execPath, [path.join(__dirname, 'playground.js'), 'local']);
if (status === 0) {
  status = run(process.execPath, [playwright, 'test', '--project=local', '--workers=1', ...process.argv.slice(2)]);
}
const down = run(process.execPath, [path.join(__dirname, 'playground.js'), 'down']);
process.exit(status || down);
