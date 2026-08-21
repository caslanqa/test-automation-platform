/**
 * Grading the grader.
 *
 * The first test is the one that matters most and looks the least like a test: **the starter dataset we
 * ship must pass its own gates.** It is what `heal-calibration.yml` runs on the first night of every
 * project that installs this plugin, and shipping a case set that fails its own thresholds would greet
 * a new user with a red nightly and teach them to disable it.
 *
 * The rest pin the two asymmetries the gate exists for: a regression called repairable must fail, and a
 * lost veto must fail even when the class was right — because the class is advice and the veto is what
 * actually blocks a repair.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { calibrateTriage, gateCalibration } from '../src/calibrate/calibrate.js';
import { loadCases, type CaseFile, type LabelledCase } from '../src/calibrate/dataset.js';
import { harvestCases, REVIEW_NOTE } from '../src/calibrate/harvest.js';
import { RUN_SCHEMA, type FailureRecord, type RunRecord, type TestRecord } from '../src/types.js';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHIPPED = path.join(packageRoot, 'templates', 'heal', 'triage-cases.json');

test('the starter dataset we ship passes its own gates', () => {
  const loaded = loadCases(packageRoot, SHIPPED);
  assert.equal(loaded.problem, undefined);
  assert.ok(loaded.cases.length >= 12, 'a set this small grades nothing');

  const report = calibrateTriage(loaded.cases);
  assert.deepEqual(
    gateCalibration(report),
    [],
    'the first nightly of every project that installs this plugin runs exactly this',
  );
  assert.equal(report.falseHeal, 0);
  assert.equal(report.missingVeto, 0);
});

test('the starter dataset covers every class, or it is not grading the classifier', () => {
  const { cases } = loadCases(packageRoot, SHIPPED);
  const covered = new Set(cases.map(entry => entry.expected));
  for (const klass of ['flaky', 'locator-drift', 'true-fail', 'env-infra', 'unknown']) {
    assert.ok(covered.has(klass as never), `no case expects ${klass}`);
  }
});

test('every case carries a note, because a label without a reason cannot be reviewed', () => {
  const raw = JSON.parse(fs.readFileSync(SHIPPED, 'utf8')) as CaseFile;
  const unexplained = raw.cases.filter(
    entry => entry.note === undefined || entry.note.trim() === '',
  );
  // Not all of them — a handful are self-evident — but the hard ones must say why.
  assert.ok(
    unexplained.length <= raw.cases.length / 3,
    `${unexplained.length} of ${raw.cases.length} cases have no note`,
  );
});

test('calling a regression repairable is a false heal, and the gate refuses it', () => {
  const mislabelled: LabelledCase = {
    name: 'a value mismatch someone labelled as drift',
    evidence: {
      outcome: 'unexpected',
      kind: 'presence-timeout',
      matcher: 'toBeVisible',
      locatorCode: "getByTestId('submit')",
      history: { runs: 20, flakeRate: 0.05, lastPassed: '2026-08-19T00:00:00.000Z' },
      testFileChanged: false,
      topFrameFileChanged: false,
      configRetries: 2,
    },
    // The evidence says drift; the human says regression. That disagreement is the false heal.
    expected: 'true-fail',
  };
  const report = calibrateTriage([mislabelled]);
  assert.equal(report.falseHeal, 1);
  assert.ok(gateCalibration(report).some(failure => failure.includes('green suite becomes a lie')));
});

test('a lost veto fails the gate even when the class is right', () => {
  const report = calibrateTriage([
    {
      name: 'a drift nobody blocked',
      evidence: {
        outcome: 'unexpected',
        kind: 'strict-mode',
        matcher: 'click',
        locatorCode: "locator('.dup')",
        history: { runs: 20, flakeRate: 0.05, lastPassed: '2026-08-19T00:00:00.000Z' },
        testFileChanged: false,
        topFrameFileChanged: false,
        configRetries: 2,
      },
      expected: 'locator-drift',
      expectedVetoes: ['test-file-edited'],
    },
  ]);
  assert.equal(report.accuracy, 1, 'the class was right');
  assert.equal(report.missingVeto, 1);
  assert.ok(gateCalibration(report).some(failure => failure.includes('lost a veto')));
});

test('an absent dataset is reported rather than silently graded as perfect', () => {
  const loaded = loadCases(packageRoot, path.join('heal', 'no-such-file.json'));
  assert.equal(loaded.cases.length, 0);
  assert.match(loaded.problem ?? '', /--harvest/);
});

test('a malformed case is dropped and counted, not thrown over', () => {
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? '/tmp', 'heal-cases-'));
  const file = path.join(dir, 'cases.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      cases: [
        { name: 'fine', evidence: { outcome: 'unexpected' }, expected: 'unknown' },
        { name: 'no expected class', evidence: { outcome: 'unexpected' } },
        { name: 'not a class', evidence: { outcome: 'unexpected' }, expected: 'sort-of-broken' },
      ],
    }),
  );
  const loaded = loadCases(dir, file);
  assert.equal(loaded.cases.length, 1);
  assert.match(loaded.problem ?? '', /ignored 2 malformed cases/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- harvest -------------------------------------------------------------------------------------

function failure(site: string, over: Partial<FailureRecord> = {}): FailureRecord {
  return {
    kind: 'presence-timeout',
    message: 'boom',
    siteFingerprint: site,
    errorFingerprint: `${site}-e`,
    taxonomyVersion: 1,
    attachments: [],
    ...over,
  };
}

function failing(key: string, site: string, over: Partial<FailureRecord> = {}): TestRecord {
  return {
    testKey: key,
    pwId: key,
    project: 'chromium',
    file: `tests/${key}.spec.ts`,
    titlePath: [key],
    line: 1,
    tags: [],
    outcome: 'unexpected',
    attempts: [
      {
        retry: 0,
        status: 'failed',
        durationMs: 1,
        workerIndex: 0,
        parallelIndex: 0,
        failure: failure(site, over),
      },
    ],
    annotations: [],
  };
}

const run = (day: number, tests: TestRecord[]): RunRecord => ({
  schema: RUN_SCHEMA,
  runId: `run-${day}`,
  startedAt: `2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`,
  durationMs: 1,
  ci: true,
  workers: 1,
  projects: ['chromium'],
  configRetries: 2,
  status: 'failed',
  globalErrors: [],
  tests,
});

test('harvest dedupes by site, so one chronic failure does not become fifty cases', () => {
  const runs = [1, 2, 3, 4, 5].map(day => run(day, [failing('a', 'same-site')]));
  assert.equal(harvestCases(runs).length, 1);
});

test('harvest puts the least certain cases first — the confident ones teach nobody anything', () => {
  const drafted = harvestCases([
    run(1, [
      // A value mismatch is about as decisive as this classifier gets.
      failing('sure', 'site-sure', {
        kind: 'value-mismatch',
        matcher: 'toHaveText',
        expected: '"a"',
        received: '"b"',
      }),
      // A bare timeout is the weakest signal there is.
      failing('unsure', 'site-unsure', {
        kind: 'test-timeout',
        message: 'Test timeout of 30000ms exceeded.',
      }),
    ]),
  ]);
  assert.equal(drafted[0].name.includes('unsure'), true);
});

test('a drafted case says out loud that its label is the classifier talking to itself', () => {
  const [drafted] = harvestCases([run(1, [failing('a', 'site-a')])]);
  assert.equal(drafted.note, REVIEW_NOTE);
  assert.match(drafted.source ?? '', /run-1/);
  // Whether the repository changed is not recoverable from a stored run, and inventing it would grade
  // the classifier against a fact nobody observed.
  assert.equal(drafted.evidence.diffUnknown, true);
});
