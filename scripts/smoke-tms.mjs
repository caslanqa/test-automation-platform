#!/usr/bin/env node
/**
 * End-to-end smoke test for the test management plugin: scaffold a real project, `add tms`, and prove
 * the things unit tests cannot.
 *
 * 1. **The injection lands.** The manifest is untyped by design, so a misspelled field is an injection
 *    that silently does nothing. Only a real `create-pwtap add` catches that.
 * 2. **`off` really is off.** A scaffolded project with this plugin installed and `TMS_MODE` unset runs
 *    green with no network. Asserted by running a spec, not by reading the code.
 * 3. **A real sync round-trips.** Against a stub Qase server: discover through Playwright's own lister,
 *    create cases, write the ids into real spec files, and then find nothing to do on a second run.
 *    Idempotence is the single strongest assertion here — it can only hold if the id we wrote is the id
 *    the next discovery reads back, through the actual runner, out of the actual edited file.
 * 4. **The edited specs still compile.** The source editor's output is fed straight back to
 *    `playwright test --list`, so a corrupted file fails here rather than in someone's repository.
 * 5. **Add and remove are symmetric.** `remove tms` has to take the reporter line, the env keys and the
 *    scripts back out, or the next `npm test` loads a reporter from a package that is gone.
 *
 * Run with `npm run smoke:tms`. Fails (non-zero) on any broken assertion.
 *
 * @example
 *   npm run smoke:tms   # prints "[smoke] OK" when injection, inertness, sync and removal all hold
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
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

/**
 * Like {@link tryRun}, but asynchronous — mandatory for anything that talks to the stub Qase below.
 * `execFileSync` blocks this process's event loop, so an in-process HTTP server cannot answer while it
 * runs and the child times out against a server that is technically listening.
 */
function tryRunAsync(cmd, args, cwd, env) {
  return new Promise(resolve => {
    execFile(
      cmd,
      args,
      { cwd, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ ok: error === null, output: `${stdout}${stderr}` }),
    );
  });
}

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

// --- 4. a real sync, against a stub Qase ---------------------------------------------------------

/**
 * Enough of Qase v1 to run a sync against, and no more. A recorded fixture would not do: the point is
 * that `tms sync` reads what it wrote, so the server has to actually hold state between the two runs.
 */
function startQase() {
  const state = { suites: [], cases: [], nextSuite: 1, nextCase: 100, patches: [] };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url, 'http://x');
      const body =
        chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const send = result =>
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ status: true, result }));

      if (url.pathname === '/v1/project/DEMO') {
        return send({ title: 'Demo Project', code: 'DEMO' });
      }
      if (url.pathname === '/v1/system-fields') {
        return send({ entities: [{ slug: 'status', options: [{ id: 3, slug: 'deprecated' }] }] });
      }
      if (url.pathname === '/v1/suite/DEMO') {
        if (request.method === 'POST') {
          const suite = {
            id: state.nextSuite++,
            title: body.title,
            parent_id: body.parent_id ?? null,
          };
          state.suites.push(suite);
          return send({ id: suite.id });
        }
        return send({ total: state.suites.length, entities: state.suites });
      }
      if (url.pathname === '/v1/case/DEMO/bulk') {
        const ids = body.cases.map(item => {
          const created = { id: state.nextCase++, isManual: false, tags: [], ...item };
          created.tags = (item.tags ?? []).map(title => ({ title }));
          state.cases.push(created);
          return created.id;
        });
        return send({ ids });
      }
      if (url.pathname === '/v1/case/DEMO') {
        return send({ total: state.cases.length, entities: state.cases });
      }
      if (url.pathname.startsWith('/v1/case/DEMO/') && request.method === 'PATCH') {
        const id = Number(url.pathname.split('/').pop());
        const target = state.cases.find(item => item.id === id);
        state.patches.push({ id, body });
        if (target !== undefined) {
          Object.assign(
            target,
            body,
            body.tags === undefined ? {} : { tags: body.tags.map(title => ({ title })) },
          );
        }
        return send({ id });
      }
      response
        .writeHead(404)
        .end(JSON.stringify({ status: false, errorMessage: `no stub for ${url.pathname}` }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        state,
        url: `http://127.0.0.1:${server.address().port}/v1`,
        close: () => new Promise(done => server.close(done)),
      }),
    );
  });
}

const qase = await startQase();
const qaseEnv = {
  TMS_MODE: 'off',
  QASE_TESTOPS_PROJECT: 'DEMO',
  QASE_TESTOPS_API_TOKEN: 'stub-token',
  QASE_API_BASE_URL: qase.url,
};

// Three shapes on purpose: a bare call the editor has to add an options object to, one that already has
// an annotation it must merge with rather than overwrite, and a parameterised loop it must refuse to
// write to at all.
fs.mkdirSync(path.join(dir, 'tests/checkout'), { recursive: true });
fs.writeFileSync(
  path.join(dir, 'tests/checkout/cart.spec.ts'),
  `import { test, expect } from '@fixtures';

test.describe('cart', () => {
  test('rejects an expired card', async () => {
    expect(1).toBe(1);
  });

  test('shows the total', { annotation: { type: 'Requirement', description: 'PAY-17' } }, async () => {
    expect(1).toBe(1);
  });

  for (const role of ['admin', 'guest']) {
    test(\`is visible to \${role}\`, async () => {
      expect(1).toBe(1);
    });
  }
});
`,
  'utf8',
);

step('tms sync (dry run)…');
const dry = await tryRunAsync('npx', ['tms', 'sync'], dir, qaseEnv);
assert(!dry.ok, 'a dry run with pending work should exit 1 so it can be a CI check');
// The scaffold ships example specs of its own, so the count is 'the four we wrote, plus those'.
const plannedCreates = Number(/create\s+(\d+)/.exec(dry.output)?.[1] ?? 0);
assert(plannedCreates >= 4, `expected at least four creates in the plan:\n${dry.output}`);
assert(qase.state.cases.length === 0, 'a dry run created something — it must change nothing');
assert(
  !fs.readFileSync(path.join(dir, 'tests/checkout/cart.spec.ts'), 'utf8').includes('QaseID'),
  'a dry run edited a spec file',
);

step('tms sync --apply…');
const applied = await tryRunAsync('npx', ['tms', 'sync', '--apply'], dir, qaseEnv);
assert(applied.ok, `sync --apply failed:\n${applied.output}`);
assert(
  qase.state.cases.length === plannedCreates,
  `the plan promised ${plannedCreates} cases, the tool got ${qase.state.cases.length}`,
);

// checkout/cart.spec.ts + describe('cart') is three levels, built parent-first and reused.
const suiteTitles = qase.state.suites.map(suite => suite.title);
assert(
  suiteTitles.slice(0, 3).join('>') === 'checkout>cart>cart',
  `suite hierarchy came out as ${suiteTitles.join('>')}`,
);
assert(
  new Set(qase.state.cases.filter(c => c.title.startsWith('is visible')).map(c => c.suite_id))
    .size === 1,
  'the parameterised pair should land in one suite',
);

const edited = fs.readFileSync(path.join(dir, 'tests/checkout/cart.spec.ts'), 'utf8');
assert(
  (edited.match(/QaseID/g) ?? []).length === 2,
  `expected exactly two ids written:\n${edited}`,
);
assert(
  /annotation: \[\{ type: 'Requirement', description: 'PAY-17' \}, \{ type: 'QaseID'/.test(edited),
  `the existing Requirement annotation was not preserved:\n${edited}`,
);
assert(
  !/is visible to \$\{role\}`, \{/.test(edited),
  'an id was written at a shared call site, where it would name both parameterised tests',
);

step('re-listing the edited spec through Playwright…');
const relist = await tryRunAsync('npx', ['playwright', 'test', '--list'], dir, qaseEnv);
assert(relist.ok, `the write-back produced a spec Playwright cannot load:\n${relist.output}`);

step('tms sync again — the second run must find nothing to do…');
const second = await tryRunAsync('npx', ['tms', 'sync'], dir, qaseEnv);
assert(second.ok, `the second sync still wanted to change something:\n${second.output}`);
assert(/nothing to do/.test(second.output), `expected "nothing to do":\n${second.output}`);
assert(qase.state.cases.length === plannedCreates, 'the second sync created duplicates');

await qase.close();
step('sync OK — created, written back, and idempotent on the second run');

// --- 5. removal is symmetric --------------------------------------------------------------------

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
