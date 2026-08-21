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

test('unresolvable: a bare timeout with nothing to go on', async ({ page }) => {
  // Gated, so the four assertions above keep their exact failure counts. A test timeout carries no
  // taxonomy weight at all, which is what makes it the one case the deterministic pass answers
  // 'unknown' — and therefore the only case escalation is ever allowed to look at.
  test.skip(process.env.HEAL_UNRESOLVABLE !== '1', 'only for the escalation step');
  test.setTimeout(1200);
  await page.goto(APP);
  await page.waitForTimeout(5000);
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

/**
 * A fake OpenAI-compatible gateway that answers by model name, so one server can act as a whole panel.
 *
 * It also records every request, which is how the strongest assertion is made: not merely that a model's
 * answer was discarded, but that the model was never asked about a failure the evidence already decided.
 */
function startGateway() {
  const asked = [];
  const classFor = model => {
    if (model.includes('drift')) return 'locator-drift';
    if (model.includes('truefail')) return 'true-fail';
    if (model.includes('env')) return 'env-infra';
    if (model.includes('flaky')) return 'flaky';
    return 'unknown';
  };
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        response.writeHead(400);
        return response.end('not json');
      }
      const model = String(parsed.model ?? '');
      asked.push({ model, prompt: JSON.stringify(parsed.messages) });
      const answer = classFor(model);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: `<think>pretending to reason</think>{"reasoning":"the fake gateway always says ${answer}","class":"${answer}"}`,
              },
            },
          ],
        }),
      );
    });
  });
  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: server.address().port, asked, close: () => server.close() }),
    ),
  );
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

const heal = (dir, args, env) =>
  spawnAsync(process.execPath, [HEAL_BIN, ...args], {
    cwd: dir,
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });

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
    assert(record.tests.length === 5, `expected 5 tests, recorded ${record.tests.length}`);
    // A skipped test IS recorded — the reporter records what ran, and 'skipped' is an outcome. What
    // matters is that it is never triaged, which the failure counts below depend on.
    assert(
      findTest(record, 'unresolvable').outcome === 'skipped',
      'the gated case must be skipped until the escalation step turns it on',
    );
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

    // 4c -------------------------------------------------------------------------------------
    // Immediately after 4b, and not at the end, because the act band needs the history steps 1-3
    // built: two green runs and one red one. By step 9 the same tests have failed nine times in a
    // row, and the classifier reads that as intermittency — correctly — and refuses to act on a
    // margin that thin. So the apply path is exercised where the evidence actually supports acting.
    step('4c: --apply writes the edit and the heal log, and a revert makes the metrics say so');
    const beforeApply = fs.readFileSync(path.join(dir, 'tests/app.spec.ts'), 'utf8');
    const applied = await heal(dir, ['propose', '--apply']);
    assert(
      applied.code === 0,
      `propose --apply should exit 0, got ${applied.code}\n${applied.stderr}`,
    );

    const healedSpec = fs.readFileSync(path.join(dir, 'tests/app.spec.ts'), 'utf8');
    // The scope is what has to be gone: the replacement string was already present as the inner half
    // of the original locator, so asserting on it alone would pass without any edit at all.
    assert(
      !healedSpec.includes("locator('form.signin')"),
      `the drifted scope should be gone from the spec:\n${applied.stdout}`,
    );
    assert(
      healedSpec.includes("toHaveText('Welcome, Ada')"),
      'and the expected value must STILL be untouched — applying a repair changes locators only',
    );

    const logPath = path.join(dir, 'heal/heal-log.jsonl');
    assert(
      fs.existsSync(logPath),
      `an applied heal must be recorded in heal/heal-log.jsonl:\n${applied.stdout}`,
    );
    const logged = fs
      .readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line));
    assert(logged.length === 1, `exactly one heal should be logged, got ${logged.length}`);
    assert(
      logged[0].proof.verdict === 'proven' && logged[0].triage.class === 'locator-drift',
      `the log should carry the proof that allowed the edit, got ${JSON.stringify(logged[0].proof)}`,
    );
    assert(
      logged[0].from.includes("locator('form.signin')") &&
        logged[0].to === "getByRole('button', { name: 'Continue' })",
      `the log should record both sides of the edit, got ${logged[0].from} -> ${logged[0].to}`,
    );

    const metrics = await heal(dir, ['metrics']);
    assert(
      metrics.code === 0,
      `a heal with no suspicion against it should pass, got ${metrics.code}\n${metrics.stdout}\n${metrics.stderr}`,
    );
    assert(
      /1 heal\(s\) applied/.test(metrics.stdout),
      `metrics should count it:\n${metrics.stdout}`,
    );

    // Ground truth beats every heuristic, and it is the only input that can never be inferred.
    const reverted = await heal(dir, [
      'revert',
      logged[0].healId,
      '--reason',
      'masked-bug',
      '--note',
      'smoke',
    ]);
    assert(
      reverted.code === 0,
      `recording a revert should succeed, got ${reverted.code}\n${reverted.stderr}`,
    );

    const masked = await heal(dir, ['metrics']);
    assert(masked.code === 1, `a recorded mask must fail the metrics gate, got ${masked.code}`);
    assert(
      /mask-rate/.test(masked.stderr),
      `the failing gate should be named, got:\n${masked.stderr}`,
    );
    assert(
      /reverted-as-masking \(GROUND TRUTH\)/.test(masked.stdout),
      `a human verdict must not be presented as a heuristic, got:\n${masked.stdout}`,
    );

    // Put the spec back: the steps below re-run the suite and expect the same three failures.
    fs.writeFileSync(path.join(dir, 'tests/app.spec.ts'), beforeApply);

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

    // 11 -------------------------------------------------------------------------------------
    // The escalation tier. Last, because it is the only step that needs a second server, and its
    // conclusions do not feed anything above it.
    step('11: a model may advise on what we could not name, and can authorise nothing');
    const gateway = await startGateway();
    const escalateEnv = {
      ...base,
      HEAL_APP_VERSION: '2',
      HEAL_UNRESOLVABLE: '1',
      JUDGE_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
      JUDGE_API_KEY: 'fake',
      // Emptied explicitly: assertion 11a is about the DEFAULT state, and a developer who has
      // JUDGE_MODEL set in their own shell would otherwise silently skip it.
      HEAL_MODEL: '',
      JUDGE_MODEL: '',
      HEAL_JURY: '',
      // A drift check must re-ask, and so must this: with the cache on, the panel steps below would
      // replay each other's answers and the tie would never happen.
      HEAL_CACHE: 'off',
    };

    try {
      writeQuarantine(dir, []);
      fs.rmSync(flag, { force: true });
      await runSuite(dir, escalateEnv);

      const readJson = () => JSON.parse(fs.readFileSync(path.join(dir, 'triage.json'), 'utf8'));
      const find = (report, needle) =>
        report.findings.find(finding => finding.title.includes(needle));

      // 11a: with no model configured, --escalate says so and changes nothing. This is the default.
      const bare = await heal(dir, ['triage', '--escalate', '--json', 'triage.json'], escalateEnv);
      assert(bare.code === 0, `--escalate with no model must not fail, got ${bare.code}`);
      assert(
        /needs a model/.test(bare.stderr),
        `it should say what to configure, got:\n${bare.stderr}`,
      );
      const before = readJson();
      assert(
        find(before, 'unresolvable')?.class === 'unknown',
        `the timeout case should be unknown deterministically, got ${find(before, 'unresolvable')?.class}`,
      );

      // 11b: the model's answer is accepted for the unknown — and capped below the act band.
      const advised = await heal(
        dir,
        ['triage', '--escalate', '--model', 'vote-drift', '--json', 'triage.json'],
        escalateEnv,
      );
      assert(
        advised.code === 0,
        `escalated triage should exit 0, got ${advised.code}\n${advised.stderr}`,
      );
      const after = readJson();
      const unresolved = find(after, 'unresolvable');
      assert(
        unresolved.class === 'locator-drift',
        `the model's class should be adopted for an unknown, got ${unresolved.class}\n${JSON.stringify(unresolved.reasons, null, 1)}\n${advised.stderr}`,
      );
      assert(
        unresolved.confidence <= 84 && unresolved.band !== 'act',
        `an escalated class must stay below the act band, got ${unresolved.confidence} (${unresolved.band})`,
      );
      assert(
        unresolved.vetoes.some(veto => veto.startsWith('escalated:')),
        `an escalated class must carry its own veto, got ${JSON.stringify(unresolved.vetoes)}`,
      );

      // 11c: THE assertion. The gateway answers 'locator-drift' to everything, including a real
      // regression — and the regression's class does not move. Stronger than discarding the answer:
      // the model was never asked, because the evidence had already decided.
      const regression = find(after, 'true regression');
      assert(
        regression.class === 'true-fail',
        `a model must not be able to reclassify a regression, got ${regression.class}`,
      );
      assert(
        !gateway.asked.some(call => call.prompt.includes('true regression')),
        'a failure the evidence already decided must never be sent to a model at all',
      );

      // And the material that WAS sent is quoted as data, under a per-call nonce.
      const sent = gateway.asked.find(call => call.prompt.includes('unresolvable'));
      assert(sent !== undefined, 'the unknown should have been escalated');
      assert(
        /<material-[0-9a-f]{8}>/.test(sent.prompt),
        'the page material must be wrapped, so the guard in the system prompt applies to it',
      );

      // 11d: a repair still refuses it. An advisory class cannot reach the bar that acts.
      const refused = await heal(dir, ['propose', '--no-verify'], escalateEnv);
      assert(refused.code === 0, `propose should exit 0, got ${refused.code}`);
      assert(
        /not examined — unknown|below the 85 needed to act/.test(refused.stdout),
        `an escalated class must not be repairable:\n${refused.stdout}`,
      );

      // 11e: a panel. Two votes for one class and one against is a plurality; one each is a tie, and a
      // tie is not a finding.
      const plurality = await heal(
        dir,
        [
          'triage',
          '--escalate',
          '--jury',
          'vote-flaky-a,vote-flaky-b,vote-env-c',
          '--json',
          'triage.json',
        ],
        escalateEnv,
      );
      assert(plurality.code === 0, `a panel run should exit 0, got ${plurality.code}`);
      const won = find(readJson(), 'unresolvable');
      assert(won.class === 'flaky', `two of three votes should carry it, got ${won.class}`);
      assert(
        won.reasons.some(reason => /agreement 0\.67/.test(reason)),
        `the split must be visible to the reader, got ${JSON.stringify(won.reasons)}`,
      );

      const tied = await heal(
        dir,
        [
          'triage',
          '--escalate',
          '--jury',
          'vote-flaky-a,vote-env-b,vote-truefail-c',
          '--json',
          'triage.json',
        ],
        escalateEnv,
      );
      assert(tied.code === 0, `a tied panel should still exit 0, got ${tied.code}`);
      const split = find(readJson(), 'unresolvable');
      assert(split.class === 'unknown', `a three-way split is not a finding, got ${split.class}`);
    } finally {
      gateway.close();
    }

    // 12 -------------------------------------------------------------------------------------
    // The answer for a config with retries off. The fixture's flaky spec fails exactly once, so a
    // probe of three separate runs must see both outcomes — which is the measurement the in-run
    // signal cannot make when there are no retries to read.
    step('12: --confirm-flake measures flakiness instead of inferring it');
    const flakyTest = latestRecord(dir).tests.find(entry =>
      entry.titlePath.join(' ').includes('really flaky'),
    );
    assert(flakyTest !== undefined, 'the flaky spec should be in the record');

    fs.rmSync(flag, { force: true });
    // The probe spawns `playwright test` itself, so the fixture server and the one-shot flag have to be
    // in the CLI's environment — not merely in this process's.
    const probe = await heal(dir, ['triage', '--confirm-flake', flakyTest.testKey, '--runs', '3'], {
      ...base,
      HEAL_APP_VERSION: '2',
    });
    assert(probe.code === 0, `the probe should exit 0, got ${probe.code}\n${probe.stderr}`);
    assert(
      /1 passed, 2 failed|2 passed, 1 failed/.test(probe.stdout),
      `three separate runs should show both outcomes, got:\n${probe.stdout}\n${probe.stderr}`,
    );
    assert(
      /— flaky\./.test(probe.stdout) && /Measured, not inferred/.test(probe.stdout),
      `the verdict should be flaky and say it was measured, got:\n${probe.stdout}`,
    );

    const missing = await heal(dir, ['triage', '--confirm-flake', 'nosuchkey']);
    assert(missing.code === 1, `an unknown key must exit 1, got ${missing.code}`);

    step('OK');
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await main();
