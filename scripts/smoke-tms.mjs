#!/usr/bin/env node
/**
 * End-to-end smoke test for the test management plugin: scaffold a real project, `add tms`, and prove
 * the three things unit tests cannot.
 *
 * 1. **The injection lands.** The manifest is untyped by design, so a misspelled field is an injection
 *    that silently does nothing. Only a real `create-pwtap add` catches that.
 * 2. **`off` really is off.** A scaffolded project with this plugin installed and `TMS_MODE` unset runs
 *    green with no network. Asserted by running a spec, not by reading the code.
 * 3. **Add and remove are symmetric.** `remove tms` has to take the reporter line, the env keys and the
 *    scripts back out, or the next `npm test` loads a reporter from a package that is gone.
 *
 * Run with `npm run smoke:tms`. Fails (non-zero) on any broken assertion.
 *
 * @example
 *   npm run smoke:tms   # prints "[smoke] OK" when injection, inertness and removal all hold
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const CREATE = path.join(root, 'packages/create/dist/index.js');

const fail = message => {
  throw new Error(`[smoke] ${message}`);
};
const assert = (condition, message) => {
  if (!condition) {
    fail(message);
  }
};
const step = message => console.log(`[smoke] ${message}`);

const run = (cmd, args, cwd, env) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: cwd ?? root, env: { ...process.env, ...env } });

/** Run and capture, returning `{ ok, output }` instead of throwing — for the cases that must fail. */
function tryRun(cmd, args, cwd, env) {
  try {
    return {
      ok: true,
      output: execFileSync(cmd, args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      }),
    };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const read = file => fs.readFileSync(file, 'utf8');
const readJson = file => JSON.parse(read(file));

/** The content of one managed marker region, so an assertion cannot pass on a line written elsewhere. */
function markerRegion(file, key) {
  const lines = read(file).split('\n');
  const start = lines.findIndex(line => line.trim() === `// pwtap:${key}`);
  const end = lines.findIndex(line => line.trim() === `// pwtap:${key}:end`);
  assert(start !== -1 && end > start, `managed markers for '${key}' missing/unbalanced in ${file}`);
  return lines.slice(start + 1, end).join('\n');
}

step('building packages…');
run('npx', ['tsc', '-b']);

step('bundling core-template into @pwtap/create…');
run('npm', ['run', 'bundle:template', '-w', '@pwtap/create']);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-tms-smoke-'));
step(`scaffolding a core-only project into ${dir}…`);
// `--no-install` and then a symlink to the monorepo's own node_modules: `@pwtap/plugin-tms` is not
// published, and the injector reads the manifest from the CLIENT's node_modules. The symlink is also
// what makes this run in seconds rather than resolving 300 packages twice.
run('node', [CREATE, dir, '-y', '--no-browsers', '--no-install']);
fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');

// What the scaffolder's own "Next steps" tell the user to do first. Injection targets both env files
// when both exist — the tracked example and the gitignored real one — and a plugin that only reached
// one of them would look installed and behave as though it were not.
fs.copyFileSync(
  path.join(dir, 'env/environments.example.json'),
  path.join(dir, 'env/environments.json'),
);

step('create-pwtap add tms…');
run('node', [CREATE, 'add', 'tms', '--no-install'], dir);

// --- 1. the injection landed --------------------------------------------------------------------

const configFile = path.join(dir, 'playwright.config.ts');
const reporters = markerRegion(configFile, 'plugins:reporters');
assert(
  reporters.includes("'@pwtap/plugin-tms/reporter'"),
  'the reporter line is not inside the plugins:reporters region',
);

for (const file of ['env/environments.json', 'env/environments.example.json']) {
  const env = readJson(path.join(dir, file)).common;
  for (const key of [
    'TMS_PROVIDER',
    'TMS_MODE',
    'QASE_TESTOPS_PROJECT',
    'QASE_TESTOPS_API_TOKEN',
    'QASE_TESTOPS_RUN_ID',
  ]) {
    assert(key in env, `${file} is missing ${key}`);
  }
  assert(env.TMS_MODE === 'off', `${file}: TMS_MODE was injected as '${env.TMS_MODE}', not 'off'`);
  assert(
    env.QASE_TESTOPS_API_TOKEN === '',
    `${file}: a token placeholder must be empty, never a value`,
  );
}

const scripts = readJson(path.join(dir, 'package.json')).scripts;
for (const name of ['tms:doctor', 'tms:run:create', 'tms:run:complete']) {
  assert(scripts[name] !== undefined, `package.json is missing the ${name} script`);
}
assert(
  fs.existsSync(path.join(dir, 'docs/TEST_MANAGEMENT.md')),
  'docs/TEST_MANAGEMENT.md was not copied',
);
assert(
  read(path.join(dir, 'README.md')).includes('## Test management'),
  'the README section is missing',
);

step('injection OK — reporter line, env keys, scripts and docs all landed');

// --- 2. off really is off -----------------------------------------------------------------------

// A spec with no `page` fixture: Playwright never launches a browser for it, so this runs on a machine
// with `--no-browsers` and proves the reporter loads, constructs and stays out of the way.
fs.writeFileSync(
  path.join(dir, 'tests/tms-smoke.spec.ts'),
  `import { test, expect } from '@fixtures';\n\ntest('the tms reporter is inert with TMS_MODE unset', () => {\n  expect(1).toBe(1);\n});\n`,
  'utf8',
);

// No `--reporter=` flag anywhere below: it REPLACES the config's reporter array outright, so passing
// one would run this whole smoke test against a Playwright that never loaded our reporter — which is
// exactly how both assertions first passed while proving nothing.
step('running one spec with TMS_MODE unset…');
const inert = tryRun(
  'npx',
  ['playwright', 'test', 'tests/tms-smoke.spec.ts', '--project=chromium'],
  dir,
  { TMS_MODE: '', QASE_TESTOPS_API_TOKEN: '', QASE_TESTOPS_PROJECT: '' },
);
assert(inert.ok, `a green suite went red with the plugin installed:\n${inert.output}`);
assert(
  !/qase|Qase/.test(inert.output),
  `the vendor reporter spoke up while switched off:\n${inert.output}`,
);

step('inert OK — the suite is green and silent with TMS_MODE unset');

// --- 3. half-configured refuses, loudly ---------------------------------------------------------

step('running the same spec with TMS_MODE=testops and no token…');
const refused = tryRun(
  'npx',
  ['playwright', 'test', 'tests/tms-smoke.spec.ts', '--project=chromium'],
  dir,
  { TMS_MODE: 'testops', QASE_TESTOPS_API_TOKEN: '', QASE_TESTOPS_PROJECT: '' },
);
assert(!refused.ok, 'publishing was requested with no credentials and the run went green anyway');
assert(
  refused.output.includes('TMS_MODE=testops but'),
  `the refusal did not name the missing configuration:\n${refused.output}`,
);

step('refusal OK — an unconfigured publish fails before a single test runs');

// --- 4. removal is symmetric --------------------------------------------------------------------

step('create-pwtap remove tms…');
run('node', [CREATE, 'remove', 'tms'], dir);

assert(
  !markerRegion(configFile, 'plugins:reporters').includes('@pwtap/plugin-tms'),
  'the reporter line survived removal — the next run would load a reporter from a missing package',
);
for (const file of ['env/environments.json', 'env/environments.example.json']) {
  const envAfter = readJson(path.join(dir, file)).common;
  for (const key of [
    'TMS_PROVIDER',
    'TMS_MODE',
    'QASE_TESTOPS_PROJECT',
    'QASE_TESTOPS_API_TOKEN',
  ]) {
    assert(!(key in envAfter), `${key} survived removal in ${file}`);
  }
}
const scriptsAfter = readJson(path.join(dir, 'package.json')).scripts;
for (const name of ['tms:doctor', 'tms:run:create', 'tms:run:complete']) {
  assert(scriptsAfter[name] === undefined, `the ${name} script survived removal`);
}

step('removal OK — add and remove are symmetric');

fs.rmSync(dir, { recursive: true, force: true });
console.log(
  '\n[smoke] OK — tms injects, stays inert until asked, refuses half-configured, and removes cleanly.',
);
