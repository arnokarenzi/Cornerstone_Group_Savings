#!/usr/bin/env node
'use strict';

// Run only first-level backend test files matching *.test.js.
// Do not recursively discover frontend source/config files that may be
// present in stale nested folders inside test/.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const backendRoot = path.resolve(__dirname, '..');
const testDir = path.join(backendRoot, 'test');
const testFiles = fs.readdirSync(testDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
  .map((entry) => path.join(testDir, entry.name))
  .sort();

if (testFiles.length === 0) {
  console.error(`No backend test files matching *.test.js found directly in ${testDir}`);
  process.exit(1);
}

console.log(`Running ${testFiles.length} backend test files; nested frontend files are excluded.\n`);
const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: backendRoot,
  stdio: 'inherit',
});

if (result.error) {
  console.error('Could not start Node.js test runner:', result.error.message);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
