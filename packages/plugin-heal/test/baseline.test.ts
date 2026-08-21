/**
 * The committed rolling aggregate.
 *
 * The property that carries the whole file is **idempotence**: the nightly job downloads overlapping
 * artifacts and re-runs on demand, so folding the same run twice must not move a counter. A doubled
 * flake rate is a quarantine nobody needed, and it would be discovered as a mystery months later.
 *
 * The counting rules are `flakeStats`'s, and they are pinned again here because this file is what the
 * classifier reads once the local runs directory has been pruned — getting them wrong here poisons every
 * classification downstream rather than one report.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  BASELINE_WINDOW,
  EMPTY_BASELINE,
  foldBaseline,
  loadBaseline,
  saveBaseline,
} from '../src/history/baseline.js';
import {
  RUN_SCHEMA,
  type AttemptRecord,
  type Baseline,
  type RunRecord,
  type TestRecord,
} from '../src/types.js';

const attempt = (over: Partial<AttemptRecord> = {}): AttemptRecord => ({
  retry: 0,
  status: 'passed',
  durationMs: 1,
  workerIndex: 0,
  parallelIndex: 0,
  ...over,
});

function record(key: string, outcome: TestRecord['outcome'], attempts = [attempt()]): TestRecord {
  return {
    testKey: key,
    pwId: key,
    project: 'chromium',
    file: 'tests/a.spec.ts',
    titlePath: [key],
    line: 1,
    tags: [],
    outcome,
    attempts,
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
  status: 'passed',
  globalErrors: [],
  tests,
});

const entryFor = (baseline: Baseline, key: string) =>
  baseline.entries.find(entry => entry.testKey === key);

test('folding the same run twice does not move a counter', () => {
  const runs = [run(1, [record('a', 'unexpected')]), run(2, [record('a', 'expected')])];
  const once = foldBaseline(runs, EMPTY_BASELINE);
  assert.equal(once.foldedRuns, 2);
  assert.equal(entryFor(once.baseline, 'a')?.runs, 2);

  const twice = foldBaseline(runs, once.baseline);
  assert.equal(twice.foldedRuns, 0, 'both runs were already folded in, by id');
  assert.equal(entryFor(twice.baseline, 'a')?.runs, 2);
});

test('a run a different machine already contributed is added, not recomputed away', () => {
  const first = foldBaseline([run(1, [record('a', 'unexpected')])], EMPTY_BASELINE).baseline;
  // A second machine sees only run 2 locally, but starts from the committed file.
  const merged = foldBaseline([run(2, [record('a', 'unexpected')])], first).baseline;
  assert.equal(entryFor(merged, 'a')?.runs, 2);
  assert.equal(entryFor(merged, 'a')?.fails, 2);
});

test('a test that did not appear in a run is not counted as a pass', () => {
  const merged = foldBaseline(
    [run(1, [record('a', 'unexpected')]), run(2, [record('b', 'expected')])],
    EMPTY_BASELINE,
  ).baseline;
  assert.equal(
    entryFor(merged, 'a')?.runs,
    1,
    'a is absent from run 2, which says nothing about it',
  );
  assert.equal(entryFor(merged, 'a')?.fails, 1);
});

test('a fully interrupted test is absence of evidence, not a failure', () => {
  const merged = foldBaseline(
    [run(1, [record('a', 'unexpected', [attempt({ status: 'interrupted' })])])],
    EMPTY_BASELINE,
  ).baseline;
  assert.equal(entryFor(merged, 'a'), undefined);
});

test('a failed-then-passed test is one flaky run, not a failure plus a pass', () => {
  const merged = foldBaseline(
    [
      run(1, [
        record('a', 'flaky', [
          attempt({ status: 'failed' }),
          attempt({ retry: 1, status: 'passed' }),
        ]),
      ]),
    ],
    EMPTY_BASELINE,
  ).baseline;
  const entry = entryFor(merged, 'a');
  assert.equal(entry?.runs, 1);
  assert.equal(entry?.fails, 0);
  assert.equal(entry?.passOnRetry, 1);
  assert.ok(entry?.lastPassed !== undefined, 'it did pass, on the retry');
});

test('counters past the window are scaled down rather than dropped', () => {
  const runs = Array.from({ length: BASELINE_WINDOW + 20 }, (_, index) =>
    run(1, [record('a', index % 2 === 0 ? 'unexpected' : 'expected')]),
  ).map((record_, index) => ({ ...record_, runId: `run-${index}` }));

  const folded = foldBaseline(runs, EMPTY_BASELINE).baseline;
  const entry = entryFor(folded, 'a');
  assert.equal(entry?.runs, BASELINE_WINDOW, 'the weight stops growing');
  // Half the runs failed, and the rate has to survive the scaling.
  assert.ok(Math.abs((entry?.fails ?? 0) / BASELINE_WINDOW - 0.5) < 0.02);
});

test('a broken baseline file is reported, and the fold still runs', () => {
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? '/tmp', 'heal-baseline-'));
  fs.mkdirSync(path.join(dir, 'heal'));
  fs.writeFileSync(path.join(dir, 'heal', 'flake-baseline.json'), '{ not json');
  const loaded = loadBaseline(dir);
  assert.match(loaded.problem ?? '', /not valid JSON/);
  assert.deepEqual(loaded.baseline.entries, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the written file is sorted by key, so a nightly diff shows only what changed', () => {
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? '/tmp', 'heal-baseline-'));
  const folded = foldBaseline(
    [run(1, [record('zzz', 'expected'), record('aaa', 'expected')])],
    EMPTY_BASELINE,
  ).baseline;
  saveBaseline(dir, folded);
  const written = loadBaseline(dir).baseline;
  assert.deepEqual(
    written.entries.map(entry => entry.testKey),
    ['aaa', 'zzz'],
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
