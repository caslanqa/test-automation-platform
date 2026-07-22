#!/usr/bin/env node
/**
 * End-to-end smoke test for the scaffolder: build → bundle → scaffold a core-only project into a
 * temp dir → assert managed markers are intact → type-check and list its tests. Run with
 * `npm run smoke`. Fails (non-zero) on any missing marker, file, or compile/list error.
 *
 * @example
 *   npm run smoke   # prints "[smoke] OK" when a fresh core scaffold builds and resolves chromium+api
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const run = (cmd, args, cwd) => execFileSync(cmd, args, { stdio: 'inherit', cwd: cwd ?? root });

function assertMarkers(file, keys) {
  const lines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map(l => l.trim());
  for (const key of keys) {
    if (!lines.includes(`// pwtap:${key}`) || !lines.includes(`// pwtap:${key}:end`)) {
      throw new Error(`[smoke] managed markers for '${key}' missing/unbalanced in ${file}`);
    }
  }
}

console.log('[smoke] building packages…');
run('npx', ['tsc', '-b']);

console.log('[smoke] bundling core-template into @pwtap/create…');
run('npm', ['run', 'bundle:template', '-w', '@pwtap/create']);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-smoke-'));
console.log(`[smoke] scaffolding core-only project into ${dir}…`);
run('node', [path.join(root, 'packages/create/dist/index.js'), dir, '-y', '--no-browsers']);

console.log('[smoke] asserting managed markers + layout…');
assertMarkers(path.join(dir, 'fixtures/index.ts'), [
  'plugins:imports',
  'plugins:tests',
  'plugins:expects',
]);
assertMarkers(path.join(dir, 'playwright.config.ts'), ['plugins:gates', 'plugins:projects']);
for (const f of [
  '.gitignore',
  'package.json',
  'tsconfig.json',
  'playwright.config.ts',
  '.commitlintrc.json',
  '.husky/pre-commit',
  '.husky/commit-msg',
  'utils/index.ts',
]) {
  if (!fs.existsSync(path.join(dir, f))) {
    throw new Error(`[smoke] expected file missing: ${f}`);
  }
}
if (fs.existsSync(path.join(dir, 'templates'))) {
  throw new Error('[smoke] templates/ should have been renamed to .gitignore and removed');
}

console.log('[smoke] type-checking scaffolded project…');
run('npx', ['tsc', '--noEmit'], dir);

console.log('[smoke] listing tests…');
run('npx', ['playwright', 'test', '--list'], dir);

console.log('\n[smoke] OK — core-only scaffold builds and resolves chromium + api.');
