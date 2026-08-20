/**
 * The numbers that judge the healer.
 *
 * Three of these pin properties that are easy to get wrong and expensive to discover late:
 *
 * - `kappaMulti` must agree with `plugin-ai-judge`'s binary `kappa` on two-class input, or the
 *   generalisation quietly means something else than the number this repo already trusts;
 * - precision below the sample floor must be **undefined**, not zero — a single unlucky heal must not
 *   read as a broken engine;
 * - the mask detector must fire on a value mismatch at the healed **line** and stay silent one line
 *   away, because that discrimination is the whole detector.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { currentHeals, type HealLogEntry } from '../src/metrics/healLog.js';
import {
  MIN_APPLIED_FOR_PRECISION,
  flakeRateTrend,
  healMetrics,
} from '../src/metrics/healMetrics.js';
import { kappaMulti } from '../src/metrics/kappaMulti.js';
import { healsRemoved } from '../src/metrics/rewritten.js';
import {
  RUN_SCHEMA,
  type AttemptRecord,
  type FailureRecord,
  type RunRecord,
  type TestRecord,
} from '../src/types.js';

const KEY = 'aaaaaaaaaaaaaaaa';
const SITE = 'site000000';

/** The binary kappa, copied from `plugin-ai-judge/src/calibrate/calibrate.ts` to compare against. */
function binaryKappa(pairs: Array<{ expected: boolean; actual: boolean }>): number {
  const total = pairs.length;
  if (total === 0) {
    return 0;
  }
  const observed = pairs.filter(pair => pair.expected === pair.actual).length / total;
  const humanPass = pairs.filter(pair => pair.expected).length / total;
  const judgePass = pairs.filter(pair => pair.actual).length / total;
  const chance = humanPass * judgePass + (1 - humanPass) * (1 - judgePass);
  if (chance === 1) {
    return observed === 1 ? 1 : 0;
  }
  return (observed - chance) / (1 - chance);
}

function failure(over: Partial<FailureRecord> = {}): FailureRecord {
  return {
    kind: 'presence-timeout',
    message: 'boom',
    siteFingerprint: SITE,
    errorFingerprint: 'error00000',
    taxonomyVersion: 1,
    attachments: [],
    ...over,
  };
}

function attempt(over: Partial<AttemptRecord> = {}): AttemptRecord {
  return { retry: 0, status: 'failed', durationMs: 10, workerIndex: 0, parallelIndex: 0, ...over };
}

function record(outcome: TestRecord['outcome'], attempts: AttemptRecord[]): TestRecord {
  return {
    testKey: KEY,
    pwId: 'x',
    project: 'chromium',
    file: 'tests/a.spec.ts',
    titlePath: ['a'],
    line: 1,
    tags: [],
    outcome,
    attempts,
    annotations: [],
  };
}

function run(day: number, tests: TestRecord[]): RunRecord {
  return {
    schema: RUN_SCHEMA,
    runId: `run-${day}`,
    startedAt: `2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`,
    durationMs: 1000,
    ci: true,
    workers: 1,
    projects: ['chromium'],
    configRetries: 2,
    status: 'failed',
    globalErrors: [],
    tests,
  };
}

function heal(over: Partial<HealLogEntry> = {}): HealLogEntry {
  return {
    healId: 'heal01',
    at: '2026-08-10T00:00:00.000Z',
    testKey: KEY,
    project: 'chromium',
    file: 'tests/a.spec.ts',
    line: 12,
    title: 'a',
    from: "locator('#x')",
    to: "getByRole('button', { name: 'Log in' })",
    siteFingerprint: SITE,
    triage: { class: 'locator-drift', confidence: 90 },
    proof: { verdict: 'proven', matched: ['role', 'name'] },
    ...over,
  };
}

const base = { quarantine: [], now: Date.parse('2026-08-20T00:00:00.000Z') };

test('kappaMulti equals the binary kappa on two-class input', () => {
  const booleans = [
    { expected: true, actual: true },
    { expected: true, actual: false },
    { expected: false, actual: false },
    { expected: false, actual: false },
    { expected: true, actual: true },
    { expected: false, actual: true },
  ];
  const labels = booleans.map(pair => ({
    expected: pair.expected ? 'pass' : 'fail',
    actual: pair.actual ? 'pass' : 'fail',
  }));
  assert.ok(Math.abs(kappaMulti(labels) - binaryKappa(booleans)) < 1e-12);
});

test('kappaMulti is zero when the agreement is exactly what chance predicts', () => {
  // Both raters answer 'a' half the time; agreeing half the time is therefore worth nothing.
  assert.equal(
    kappaMulti([
      { expected: 'a', actual: 'a' },
      { expected: 'a', actual: 'b' },
      { expected: 'b', actual: 'a' },
      { expected: 'b', actual: 'b' },
    ]),
    0,
  );
});

test('kappaMulti reports the extreme rather than dividing by zero when one class is all there is', () => {
  assert.equal(kappaMulti([{ expected: 'a', actual: 'a' }]), 1);
  assert.equal(kappaMulti([{ expected: 'a', actual: 'b' }]), 0);
});

test('precision is undefined below the sample floor, not zero', () => {
  const metrics = healMetrics({
    ...base,
    heals: [heal()],
    runs: [run(11, [record('unexpected', [attempt({ failure: failure() })])])],
  });
  assert.equal(metrics.applied, 1);
  assert.equal(metrics.regressed, 1);
  assert.equal(metrics.precision, undefined, 'one unlucky heal must not read as a broken engine');
  assert.ok(MIN_APPLIED_FOR_PRECISION > 1);
});

test('precision counts a heal whose site stopped failing', () => {
  const heals = Array.from({ length: MIN_APPLIED_FOR_PRECISION }, (_, index) =>
    heal({ healId: `heal${index}`, testKey: `key${index}` }),
  );
  const runs = [run(11, [record('expected', [attempt({ status: 'passed' })])])];
  const metrics = healMetrics({ ...base, heals, runs });
  assert.equal(metrics.survived, MIN_APPLIED_FOR_PRECISION);
  assert.equal(metrics.precision, 1);
});

test('a value mismatch at the healed line is a suspected mask; one line away is not', () => {
  const at = (line: number): RunRecord =>
    run(11, [
      record('unexpected', [
        attempt({
          failure: failure({
            kind: 'value-mismatch',
            siteFingerprint: 'moved-on000',
            topFrame: { file: 'tests/a.spec.ts', line },
          }),
        }),
      ]),
    ]);

  const hit = healMetrics({ ...base, heals: [heal()], runs: [at(12)] });
  assert.deepEqual(hit.masked[0]?.detectors, ['value-mismatch-at-the-healed-line']);
  assert.equal(hit.maskRate, 1);

  const miss = healMetrics({ ...base, heals: [heal()], runs: [at(13)] });
  assert.equal(miss.masked.length, 0);
  assert.equal(miss.maskRate, 0);
});

test('a heal reverted as masking is ground truth, and outranks any heuristic', () => {
  const metrics = healMetrics({
    ...base,
    heals: [
      heal(),
      heal({
        at: '2026-08-12T00:00:00.000Z',
        revertedAt: '2026-08-12T00:00:00.000Z',
        revertReason: 'masked-bug',
      }),
    ],
    runs: [],
  });
  assert.equal(
    metrics.applied,
    1,
    'the revert supersedes the entry it names rather than adding one',
  );
  assert.deepEqual(metrics.masked[0]?.detectors, ['reverted-as-masking']);
});

test("a revert for 'no longer needed' is ordinary churn, not a mask", () => {
  const metrics = healMetrics({
    ...base,
    heals: [heal({ revertedAt: '2026-08-12T00:00:00.000Z', revertReason: 'no-longer-needed' })],
    runs: [],
  });
  assert.equal(metrics.masked.length, 0);
});

test('a heal whose locator is gone from the spec is a suspected mask', () => {
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? '/tmp', 'heal-removed-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  const spec = path.join(dir, 'tests/a.spec.ts');

  fs.writeFileSync(
    spec,
    "await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();\n",
  );
  assert.equal(healsRemoved(dir, [heal()]).get('heal01'), false, 'still there');

  // Moving it does not count: lines drift, and a heal three lines down was not undone.
  fs.writeFileSync(spec, `\n\n${fs.readFileSync(spec, 'utf8')}`);
  assert.equal(healsRemoved(dir, [heal()]).get('heal01'), false);

  fs.writeFileSync(spec, "await expect(page.locator('#x')).toBeVisible();\n");
  assert.equal(healsRemoved(dir, [heal()]).get('heal01'), true, 'somebody took it back out');

  // An unreadable file is an absence of evidence, and a detector gated at zero must not fire on one.
  fs.rmSync(spec);
  assert.equal(healsRemoved(dir, [heal()]).get('heal01'), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('the mask rate is zero with nothing applied — nothing was hidden', () => {
  const metrics = healMetrics({ ...base, heals: [], runs: [] });
  assert.equal(metrics.maskRate, 0);
  assert.equal(metrics.applied, 0);
});

test('currentHeals lets a revert win over the entry it supersedes', () => {
  const entries = [
    heal(),
    heal({
      at: '2026-08-11T00:00:00.000Z',
      revertedAt: '2026-08-11T00:00:00.000Z',
      revertReason: 'wrong-element',
    }),
  ];
  assert.equal(currentHeals(entries).length, 1);
  assert.equal(currentHeals(entries)[0].revertReason, 'wrong-element');
  // Order must not decide it: a log read backwards has to give the same answer.
  assert.equal(currentHeals([...entries].reverse())[0].revertReason, 'wrong-element');
});

test('the flake-rate trend needs two full windows before it says anything', () => {
  const runs = [run(11, [record('expected', [attempt({ status: 'passed' })])])];
  assert.equal(flakeRateTrend(runs, 1), undefined);
  assert.deepEqual(
    flakeRateTrend(
      [...runs, run(12, [record('unexpected', [attempt({ failure: failure() })])])],
      1,
    ),
    { recent: 1, previous: 0, delta: 1 },
  );
});
