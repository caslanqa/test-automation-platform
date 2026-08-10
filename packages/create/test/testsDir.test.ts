/**
 * Rewriting a plugin's `tests/…` references onto a renamed tests folder.
 *
 * Example destinations were already rewritten; **script values were not**, and `@pwtap/plugin-perf` is the first
 * plugin whose script names a test path (`playwright test tests/perf`). On a project scaffolded with
 * `--tests-dir e2e` that ran against a folder that does not exist and reported "no tests found", which reads like
 * the plugin failed to install rather than like a path bug.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { readTestsDir, remapTestsDirInScript, remapTestsDirPath } from '../src/util/testsDir.js';

test('a path destination moves onto the renamed folder', () => {
  assert.equal(remapTestsDirPath('tests/perf', 'e2e'), 'e2e/perf');
  assert.equal(remapTestsDirPath('tests', 'e2e'), 'e2e');
  assert.equal(remapTestsDirPath('tests/db/migrations', 'specs'), 'specs/db/migrations');
});

test('a destination outside tests/ is untouched', () => {
  assert.equal(remapTestsDirPath('perf', 'e2e'), 'perf');
  assert.equal(remapTestsDirPath('db', 'e2e'), 'db');
  // A folder whose name merely starts with "tests" is a different folder.
  assert.equal(remapTestsDirPath('tests-old/x', 'e2e'), 'tests-old/x');
});

test('the default folder is a no-op, so nothing is rewritten needlessly', () => {
  assert.equal(remapTestsDirPath('tests/perf', 'tests'), 'tests/perf');
  assert.equal(
    remapTestsDirInScript('playwright test tests/perf', 'tests'),
    'playwright test tests/perf',
  );
});

test('a script argument is rewritten', () => {
  assert.equal(
    remapTestsDirInScript('playwright test tests/perf --workers=1', 'e2e'),
    'playwright test e2e/perf --workers=1',
  );
  assert.equal(
    remapTestsDirInScript('playwright test tests/perf tests/api', 'e2e'),
    'playwright test e2e/perf e2e/api',
  );
});

test('a quoted glob and an =-attached path are rewritten too', () => {
  assert.equal(remapTestsDirInScript('eslint "tests/**/*.ts"', 'e2e'), 'eslint "e2e/**/*.ts"');
  assert.equal(remapTestsDirInScript('tool --dir=tests/perf', 'e2e'), 'tool --dir=e2e/perf');
});

test('a script that only LOOKS like it names the folder is left alone', () => {
  assert.equal(remapTestsDirInScript('npm run test:perf', 'e2e'), 'npm run test:perf');
  // A pattern, not a path. Rewriting it would silently change what the script matches — the reason the rewrite
  // requires a trailing slash.
  assert.equal(
    remapTestsDirInScript('playwright test --grep tests', 'e2e'),
    'playwright test --grep tests',
  );
  assert.equal(
    remapTestsDirInScript('node scripts/tests-helper.mjs', 'e2e'),
    'node scripts/tests-helper.mjs',
  );
  // A different folder that happens to share the prefix.
  assert.equal(remapTestsDirInScript('rm -rf tests-old/x', 'e2e'), 'rm -rf tests-old/x');
});

test('readTestsDir reads what create recorded, and falls back when it is absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-testsdir-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ pwtap: { testsDir: 'e2e' } }),
    );
    assert.equal(readTestsDir(dir), 'e2e');

    // An older project, scaffolded before the field existed.
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    assert.equal(readTestsDir(dir), 'tests');

    // Unreadable or malformed: still usable, never throws.
    fs.writeFileSync(path.join(dir, 'package.json'), 'not json');
    assert.equal(readTestsDir(dir), 'tests');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
