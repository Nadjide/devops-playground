#!/usr/bin/env node
/**
 * Scan tracked files for credential-shaped strings before publishing.
 * Exits non-zero when a likely secret is found.
 */
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');

const PATTERNS = [
  ['AWS access key', /\b(A3T[A-Z0-9]|AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Azure storage key assignment', /AccountKey=(?!Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq\/K1SZFPTOtr\/KBHBeksoGMGw==)[A-Za-z0-9+/]{40,}={0,2}/],
  ['Generic bearer token', /Authorization:\s*Bearer\s+[A-Za-z0-9_-]{32,}/i],
];
const SKIP = /(^|\/)(package-lock\.json|.*\.png|.*\.svg)$/;

const files = spawnSync('git', ['ls-files'], { encoding: 'utf8' }).stdout.split('\n').filter((file) => file && !SKIP.test(file));
const findings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, index) => {
    for (const [label, pattern] of PATTERNS) {
      if (pattern.test(line)) {
        findings.push(`${file}:${index + 1} ${label}`);
      }
    }
  });
}

if (findings.length) {
  console.error('Possible secrets found in tracked files:');
  for (const finding of findings) {
    console.error(`  ${finding}`);
  }
  process.exit(1);
}
console.log(`No credential-shaped strings in ${files.length} tracked files.`);
