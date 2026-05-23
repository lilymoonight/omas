#!/usr/bin/env node
/**
 * Extract one version section from CHANGELOG.md for GitHub Release body.
 * Usage: node scripts/extract-changelog.mjs 0.2.5 > release-notes.md
 */
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2]?.replace(/^v/, '');
if (!version) {
  console.error('usage: extract-changelog.mjs <version>');
  process.exit(1);
}

const changelog = readFileSync('CHANGELOG.md', 'utf8');
const start = changelog.indexOf(`## [${version}]`);
if (start === -1) {
  console.error(`section ## [${version}] not found in CHANGELOG.md`);
  process.exit(1);
}

const rest = changelog.slice(start);
const next = rest.slice(`## [${version}]`.length).search(/^## \[/m);
const section = (next === -1 ? rest : rest.slice(0, `## [${version}]`.length + next)).trim();

const out = process.argv[3];
if (out) {
  writeFileSync(out, `${section}\n`);
} else {
  process.stdout.write(`${section}\n`);
}
