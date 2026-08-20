#!/usr/bin/env node
/**
 * End-to-end smoke test for the healing engine: the reporter records a real Playwright run, the
 * classifier reads it, and quarantine suppresses an exit status without deleting coverage.
 *
 * Run with `npm run smoke:heal`. Fails (non-zero) on any broken assertion.
 *
 * **The one assertion that matters most is #5: a real regression is NOT healable.** If the engine
 * ever classifies a changed *value* as something it may rewrite, a green suite becomes a lie — and
 * that is precisely what the official Playwright healer permits. It is asserted here, in CI, against
 * a real browser, rather than argued for in a document.
 *
 * Determinism without real flakiness: two committed fixture files, served by an in-process server
 * chosen by an env var, so `v1 → v2` is a byte-identical, replayable change and nothing in the trial
 * project is edited between runs. The flaky spec uses a **file-backed** one-shot flag because each
 * retry runs in a fresh worker process — a module-level counter resets and never goes flaky, which
 * was measured, not assumed.
 *
 * @example
 *   npm run smoke:heal   # prints "[smoke] OK" when triage, shielding and expiry all hold
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const HEAL_DIST = path.join(root, 'packages/plugin-heal/dist');
const HEAL_BIN = path.join(root, 'packages/plugin-heal/bin/heal.mjs');
const FIXTURES = path.join(root, 'scripts/fixtures/heal-app');

const fail = message => {
  throw new Error(`[smoke] ${message}`);
};
const assert = (condition, message) => {
  if (!condition) {
    fail(message);
  }
};
const step = message => console.log(`[smoke] ${message}`);

// --- the fixture app ---------------------------------------------------------------------------

/** Serves v1 or v2 by env var, so the change between runs is a version, not an edit. */
function startApp() {
  const pages = {
    v1: fs.readFileSync(path.join(FIXTURES, 'v1.html'), 'utf8'),
    v2: fs.readFileSync(path.join(FIXTURES, 'v2.html'), 'utf8'),
  };
  const server = http.createServer((req, res) => {
    const version = new URL(req.url, 'http://x').searchParams.get('v') === '2' ? 'v2' : 'v1';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pages[version]);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, close: () => new Promise(done => server.close(done)) });
    });
  });
}

// --- the trial project -------------------------------------------------------------------------

const SPECS = `import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const APP = \`\${process.env.HEAL_APP_URL}?v=\${process.env.HEAL_APP_VERSION ?? '1'}\`;

test('locator drift: the button keeps its name and loses its test id', async ({ page }) => {
  await page.goto(APP);
  await expect(page.getByTestId('submit')).toBeVisible();
});

test('true regression: the greeting says something else', async ({ page }) => {
  await page.goto(APP);
  await expect(page.locator('p')).toHaveText('Welcome, Ada');
});

test('provable drift: a structural wrapper renamed under a role+name locator', async ({ page }) => {
  await page.goto(APP);
  // Two signals in the code — role and accessible name — plus a structural scope that is the thing
  // that drifted. That is the only shape in which a replacement can be PROVEN to be the same element.
  await expect(page.locator('form.signin').getByRole('button', { name: 'Continue' })).toBeVisible();
});

test('really flaky: fails once, then passes', async ({ page }) => {
  // A retry runs in a FRESH worker process, so a module-level counter resets and this would never
  // go flaky. The flag has to outlive the process.
  const flag = process.env.HEAL_FLAKY_FLAG;
  const firstAttempt = !fs.existsSync(flag);
  if (firstAttempt) fs.writeFileSync(flag, '1');
  await page.goto(APP);
  // Named rather than a bare tag selector: the fixture has two buttons, so locator('button')
  // would be a strict-mode violation instead of the intermittent failure this spec produces.
  // (No backticks in here — this whole spec text lives inside a template literal.)
  await expect(page.getByRole('button', { name: 'Log in' })).toHaveText(
    firstAttempt ? 'Nope' : 'Log in',
  );
});
`;

const configFor = port => `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  reporter: [
    ['list'],
    ['${path.join(HEAL_DIST, 'reporter.js')}', { runsDir: '.heal/runs' }],
  ],
  retries: 1,
  timeout: 20000,
  expect: { timeout: 1500 },
  use: { headless: true, actionTimeout: 1500, baseURL: 'http://127.0.0.1:${port}' },
});
`;

function createProject(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-heal-smoke-'));
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'playwright.config.ts'), configFor(port));
  fs.writeFileSync(path.join(dir, 'tests', 'app.spec.ts'), SPECS);
  // The monorepo's own node_modules: no install, no browser download.
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');

  // A real repository, because the classifier's diff correlation is real evidence and a smoke that
  // skipped it would never exercise the "nothing in the repo changed" path.
  const git = args => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '-q']);
  git(['config', 'user.email', 'smoke@example.com']);
  git(['config', 'user.name', 'smoke']);
  git(['add', '-A']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'trial project']);
  return dir;
}

// --- running -----------------------------------------------------------------------------------

/** Async, never spawnSync: the fixture server lives in this process and must stay answerable. */
function spawnAsync(command, args, options) {
  return new Promise(resolve => {
    execFile(command, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) =>
      resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
}

const runSuite = (dir, env) =>
  spawnAsync('npx', ['playwright', 'test'], { cwd: dir, env: { ...process.env, ...env } });

const heal = (dir, args) => spawnAsync(process.execPath, [HEAL_BIN, ...args], { cwd: dir });

const runFiles = dir => {
  const runsDir = path.join(dir, '.heal', 'runs');
  return fs.existsSync(runsDir)
    ? fs
        .readdirSync(runsDir)
        .filter(n => n.endsWith('.json'))
        .sort()
    : [];
};

const latestRecord = dir => {
  const files = runFiles(dir);
  assert(files.length > 0, 'no run record was written');
  return JSON.parse(
    fs.readFileSync(path.join(dir, '.heal', 'runs', files[files.length - 1]), 'utf8'),
  );
};

const findTest = (record, needle) => {
  const found = record.tests.find(test => test.titlePath.join(' ').includes(needle));
  assert(found !== undefined, `no recorded test matching '${needle}'`);
  return found;
};

const writeQuarantine = (dir, entries) => {
  fs.mkdirSync(path.join(dir, 'heal'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'heal', 'quarantine.json'),
    `${JSON.stringify({ version: 1, entries }, null, 2)}\n`,
  );
};

const iso = offsetDays => new Date(Date.now() + offsetDays * 86_400_000).toISOString();

const quarantineEntry = (test, expiresAt) => ({
  testKey: test.testKey,
  project: test.project,
  file: test.file,
  title: test.titlePath.join(' › '),
  class: 'flaky',
  reason: 'quarantined by the smoke test',
  addedAt: iso(-1),
  expiresAt,
  addedBy: 'smoke',
  issue: 'https://example.com/issues/1',
  evidence: { flakeRate: 0.4, runs: 20 },
});

// --- the run -----------------------------------------------------------------------------------

async function main() {
  step('building packages…');
  execFileSync('npx', ['tsc', '-b'], { stdio: 'inherit', cwd: root });

  const app = await startApp();
  const dir = createProject(app.port);
  const flag = path.join(dir, 'flaky.flag');
  const base = { HEAL_APP_URL: `http://127.0.0.1:${app.port}/`, HEAL_FLAKY_FLAG: flag };

  try {
    // 1 --------------------------------------------------------------------------------------
    step('1: a green run against v1 is recorded and stays green');
    fs.rmSync(flag, { force: true });
    let result = await runSuite(dir, { ...base, HEAL_APP_VERSION: '1' });
    assert(result.code === 0, `v1 should pass, exit was ${result.code}\n${result.stdout}`);
    assert(runFiles(dir).length === 1, `expected one run record, got ${runFiles(dir).length}`);

    let record = latestRecord(dir);
    assert(record.status === 'passed', `recorded status should be passed, was ${record.status}`);
    assert(record.tests.length === 4, `expected 4 tests, recorded ${record.tests.length}`);
    assert(record.commit !== undefined, 'the commit should be recorded from the real repository');
    const driftKey = findTest(record, 'locator drift').testKey;
    assert(typeof driftKey === 'string' && driftKey.length === 16, 'a test key should be recorded');

    // The flaky spec goes flaky even on v1 — that is what the one-shot flag is for.
    const flakyFirst = findTest(record, 'really flaky');
    assert(
      flakyFirst.outcome === 'flaky',
      `the flaky spec should report outcome 'flaky', got '${flakyFirst.outcome}'`,
    );

    // 2 --------------------------------------------------------------------------------------
    step('2: a second run keeps the same test key — cross-run identity holds');
    fs.rmSync(flag, { force: true });
    result = await runSuite(dir, { ...base, HEAL_APP_VERSION: '1' });
    assert(result.code === 0, `the second v1 run should pass, exit was ${result.code}`);
    assert(runFiles(dir).length === 2, `expected two run records, got ${runFiles(dir).length}`);
    assert(
      findTest(latestRecord(dir), 'locator drift').testKey === driftKey,
      'the same test must keep the same key across runs, or no history is possible',
    );

    // 3 --------------------------------------------------------------------------------------
    step('3: v2 breaks the run, and triage reads the real Playwright error');
    fs.rmSync(flag, { force: true });
    result = await runSuite(dir, { ...base, HEAL_APP_VERSION: '2' });
    assert(result.code !== 0, 'v2 must fail the run');

    const triage = await heal(dir, ['triage', '--json', '.heal/triage.json']);
    assert(triage.code === 0, `triage should exit 0, got ${triage.code}\n${triage.stderr}`);
    const findings = JSON.parse(
      fs.readFileSync(path.join(dir, '.heal/triage.json'), 'utf8'),
    ).findings;

    const drift = findings.find(f => f.title.includes('locator drift'));
    assert(drift !== undefined, 'the drift failure should be triaged');
    assert(
      drift.class === 'locator-drift',
      `the lost test id should read as locator-drift, got '${drift.class}'`,
    );
    assert(
      drift.reasons.some(reason => reason.includes('presence-timeout')),
      `the evidence should name the error kind, got: ${JSON.stringify(drift.reasons)}`,
    );
    assert(
      drift.confidence >= 85 && drift.band === 'act',
      `a clean drift reading with history should reach the act band, got ${drift.confidence}`,
    );

    // 5 (numbered as in the plan) ------------------------------------------------------------
    step('5: a real regression is true-fail, and is vetoed from any autofix');
    const regression = findings.find(f => f.title.includes('true regression'));
    assert(regression !== undefined, 'the value change should be triaged');
    assert(
      regression.class === 'true-fail',
      `a changed value must read as true-fail, got '${regression.class}' — a green suite would become a lie`,
    );
    assert(
      regression.vetoes.some(veto => veto.startsWith('value-mismatch')),
      `the veto must name the reason, got: ${JSON.stringify(regression.vetoes)}`,
    );

    // 6 --------------------------------------------------------------------------------------
    step('6: the flaky spec is flaky, not drift and not a regression');
    const flaky = findings.find(f => f.title.includes('really flaky'));
    assert(flaky !== undefined, 'the flaky spec should be triaged');
    assert(flaky.class === 'flaky', `expected flaky, got '${flaky.class}'`);
    assert(
      flaky.vetoes.includes('not-locator-drift'),
      'a flake must never be eligible for a locator rewrite',
    );

    // 4a -------------------------------------------------------------------------------------
    step('4a: propose refuses to claim proof when the code stated only an identifier');
    let propose = await heal(dir, ['propose', '--no-verify']);
    assert(propose.code === 0, `propose should exit 0, got ${propose.code}\n${propose.stderr}`);

    const proposals = () =>
      fs.existsSync(path.join(dir, '.heal/proposals'))
        ? fs.readdirSync(path.join(dir, '.heal/proposals')).sort()
        : [];
    const provenanceFor = needle => {
      for (const name of proposals()) {
        const file = path.join(dir, '.heal/proposals', name, 'provenance.json');
        if (!fs.existsSync(file)) continue;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed.title.includes(needle))
          return { dir: path.join(dir, '.heal/proposals', name), ...parsed };
      }
      return undefined;
    };

    const identifierOnly = provenanceFor('locator drift');
    assert(identifierOnly !== undefined, 'the identifier-only drift should get a proposal');
    assert(
      identifierOnly.proof.verdict === 'refused',
      `a locator that stated only a test id cannot be proven, got '${identifierOnly.proof.verdict}'`,
    );
    // Two independent reasons, and both are true: the page's elements are indistinguishable from a
    // locator that named none of them, and even the leader cannot be shown to be the same element.
    assert(
      identifierOnly.refusals.some(r => r.includes('no-shared-signal')),
      `the refusal must say nothing could be checked against, got: ${JSON.stringify(identifierOnly.refusals)}`,
    );
    assert(
      identifierOnly.refusals.some(r => r.includes('ambiguous')),
      `and that the candidates were indistinguishable, got: ${JSON.stringify(identifierOnly.refusals)}`,
    );
    // It still offers the ranked candidates — refusing to PROVE is not refusing to help.
    assert(
      identifierOnly.candidatesConsidered.some(
        c => c.code === "getByRole('button', { name: 'Log in' })",
      ),
      `the ranked candidates should include the obvious replacement, got: ${JSON.stringify(
        identifierOnly.candidatesConsidered.map(c => c.code),
      )}`,
    );
    assert(identifierOnly.applied === false, 'nothing may be applied for a refused proof');

    // 4b -------------------------------------------------------------------------------------
    step('4b: propose PROVES the case where the code stated two signals, and verifies it');
    propose = await heal(dir, ['propose']);
    assert(propose.code === 0, `propose should exit 0, got ${propose.code}\n${propose.stderr}`);

    const provable = provenanceFor('provable drift');
    assert(provable !== undefined, 'the provable drift should get a proposal');
    assert(
      provable.proof.verdict === 'proven',
      `role and name both matching should prove it, got '${provable.proof.verdict}': ${JSON.stringify(
        provable.proof.reasons,
      )}`,
    );
    assert(
      provable.proof.matched.includes('role') && provable.proof.matched.includes('name'),
      `both signals should be recorded, got ${JSON.stringify(provable.proof.matched)}`,
    );
    assert(
      provable.to.code === "getByRole('button', { name: 'Continue' })",
      `unexpected replacement: ${provable.to?.code}`,
    );
    assert(
      provable.verification?.greens === 3 && provable.verification.assertionRan === true,
      `three greens and the original assertion still running, got ${JSON.stringify(provable.verification)}`,
    );
    assert(
      fs.existsSync(path.join(provable.dir, 'patch.diff')),
      'a proven, verified candidate should produce a patch',
    );
    assert(
      provable.applied === false,
      'still nothing applied — --apply was not given, and advisory is the default',
    );
    // The spec on disk is untouched: propose restores the file after verifying.
    assert(
      fs
        .readFileSync(path.join(dir, 'tests/app.spec.ts'), 'utf8')
        .includes("locator('form.signin')"),
      'propose must restore the spec after a verification run',
    );

    // 5 --------------------------------------------------------------------------------------
    step('5: the value change is never even examined, let alone repaired');
    assert(
      provenanceFor('true regression') === undefined,
      'a true-fail must never get a repair proposal — it is not a candidate at all',
    );
    assert(
      /not examined — true-fail/.test(propose.stdout),
      `propose should say why it skipped the regression, got:\n${propose.stdout}`,
    );
    const specText = fs.readFileSync(path.join(dir, 'tests/app.spec.ts'), 'utf8');
    assert(
      specText.includes("toHaveText('Welcome, Ada')"),
      'the expected value must still be the original — rewriting it would hide the bug',
    );

    // 6b -------------------------------------------------------------------------------------
    step('6b: a flake is not a repair candidate either');
    assert(
      provenanceFor('really flaky') === undefined,
      'a flake must never be offered a locator rewrite',
    );

    // 7 --------------------------------------------------------------------------------------
    step('7: quarantine suppresses the exit status without deleting coverage');
    const failing = latestRecord(dir).tests.filter(test => test.outcome === 'unexpected');
    assert(failing.length === 3, `expected 3 unexpected failures, got ${failing.length}`);
    writeQuarantine(
      dir,
      failing.map(test => quarantineEntry(test, iso(1))),
    );

    fs.rmSync(flag, { force: true });
    result = await runSuite(dir, { ...base, HEAL_APP_VERSION: '2' });
    assert(result.code === 0, `shielding should suppress the exit status, exit was ${result.code}`);
    assert(
      /did not fail the run/.test(result.stdout),
      'the run should say which failures were shielded',
    );
    // Coverage is intact: the tests ran and their failures are still in the record.
    assert(
      latestRecord(dir).tests.filter(test => test.outcome === 'unexpected').length ===
        failing.length,
      'a quarantined test must still run and still record its failure — that is the whole point',
    );

    // 8 --------------------------------------------------------------------------------------
    step('8: an expired entry stops shielding, and the run goes red again');
    writeQuarantine(
      dir,
      failing.map(test => quarantineEntry(test, iso(-1))),
    );
    fs.rmSync(flag, { force: true });
    result = await runSuite(dir, { ...base, HEAL_APP_VERSION: '2' });
    assert(result.code !== 0, 'an expired quarantine must not shield');
    assert(/EXPIRED/.test(result.stdout), 'the run should name the expired entries');

    // 9 --------------------------------------------------------------------------------------
    step('9: the gate gates — flip one budget and require a non-zero exit that names the case');
    writeQuarantine(
      dir,
      failing.map(test => quarantineEntry(test, iso(1))),
    );
    const ok = await heal(dir, ['gate', '--max-quarantine', '5']);
    assert(ok.code === 0, `a healthy list should pass the gate, got ${ok.code}\n${ok.stderr}`);

    const tight = await heal(dir, ['gate', '--max-quarantine', '0']);
    assert(tight.code === 1, `an exceeded budget must exit 1, got ${tight.code}`);
    assert(/max-entries/.test(tight.stderr), 'the failing gate should be named');
    assert(
      failing.some(test => tight.stderr.includes(test.titlePath[test.titlePath.length - 1])),
      'the gate must name the entries responsible, not just a count',
    );

    // The gate's second half: a failing run whose failures are not ALL covered. Drop one entry and
    // the gate must fail and name the test that is now uncovered.
    writeQuarantine(dir, [quarantineEntry(failing[0], iso(1))]);
    const partial = await heal(dir, ['gate', '--max-quarantine', '5']);
    assert(partial.code === 1, `an uncovered failure must fail the gate, got ${partial.code}`);
    const uncovered = failing[1].titlePath[failing[1].titlePath.length - 1];
    assert(
      partial.stderr.includes(uncovered),
      `the gate must name the uncovered test '${uncovered}', got:\n${partial.stderr}`,
    );

    step('OK');
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await main();
