/**
 * Flake arithmetic. Two of these pin bugs that are easy to write and hard to notice:
 *
 * - a run in which the test **did not appear** must not count as a pass, or a test that is usually
 *   skipped looks perfectly stable;
 * - a failed-then-passed test is **one** flaky run, not one failure plus one pass — which is exactly
 *   what the shipped appium report gets wrong, so it is pinned here so we never ship it too.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { flakeStats } from '../src/history/flakeStats.js';
import { RUN_SCHEMA, type AttemptRecord, type RunRecord, type TestRecord } from '../src/types.js';

const KEY = 'aaaaaaaaaaaaaaaa';

const attempt = (over: Partial<AttemptRecord> = {}): AttemptRecord => ({
  retry: 0,
  status: 'passed',
  durationMs: 10,
  workerIndex: 0,
  parallelIndex: 0,
  ...over,
});

function record(outcome: TestRecord['outcome'], attempts = [attempt()]): TestRecord {
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

/** `day` becomes the timestamp, so ordering is explicit rather than clock-dependent. */
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
    status: 'passed',
    globalErrors: [],
    tests,
  };
}

test('no history at all reports zero runs rather than a confident zero flake rate', () => {
  const stats = flakeStats([], KEY);
  assert.equal(stats.runs, 0);
  assert.equal(stats.flakeRate, 0);
  assert.equal(stats.neverPassed, true);
});

test('a run in which the test did not appear is not counted as a pass', () => {
  const runs = [run(1, [record('expected')]), run(2, []), run(3, [])];
  const stats = flakeStats(runs, KEY);
  assert.equal(stats.runs, 1, 'only the run that actually produced a verdict counts');
  assert.equal(stats.flakeRate, 0);
});

test('a skipped test is not evidence either', () => {
  const stats = flakeStats([run(1, [record('skipped')]), run(2, [record('expected')])], KEY);
  assert.equal(stats.runs, 1);
});

test('an interrupted run is absence of evidence, not a pass', () => {
  const interrupted = record('unexpected', [attempt({ status: 'interrupted' })]);
  const stats = flakeStats([run(1, [interrupted]), run(2, [record('expected')])], KEY);
  assert.equal(stats.runs, 1, 'the interrupted run is excluded from the denominator');
  assert.equal(stats.fails, 0);
});

test('a failed-then-passed test is one flaky run, not a failure plus a pass', () => {
  const flaky = record('flaky', [
    attempt({ retry: 0, status: 'failed' }),
    attempt({ retry: 1, status: 'passed' }),
  ]);
  const stats = flakeStats([run(1, [flaky])], KEY);
  assert.equal(stats.runs, 1);
  assert.equal(stats.fails, 0, 'a flaky run is not a failure');
  assert.equal(stats.flakyRuns, 1);
  assert.equal(stats.flakeRate, 1);
  assert.equal(stats.neverPassed, false, 'it did pass, on the retry');
});

test('flakeRate counts every run that did not simply pass', () => {
  const runs = [
    run(1, [record('expected')]),
    run(2, [record('expected')]),
    run(3, [record('unexpected', [attempt({ status: 'failed' })])]),
    run(4, [record('flaky', [attempt({ status: 'failed' }), attempt({ retry: 1 })])]),
  ];
  const stats = flakeStats(runs, KEY);
  assert.equal(stats.runs, 4);
  assert.equal(stats.fails, 1);
  assert.equal(stats.flakyRuns, 1);
  assert.equal(stats.flakeRate, 0.5);
  assert.equal(stats.recoveryRate, 0.5, 'half the failing runs recovered on a retry');
});

test('the window keeps the most recent runs, not whatever the filesystem returned first', () => {
  const runs = Array.from({ length: 30 }, (_, i) =>
    run(i + 1, [record(i < 20 ? 'unexpected' : 'expected', [attempt({ status: 'failed' })])]),
  );
  const stats = flakeStats(runs, KEY, { window: 5 });
  assert.equal(stats.runs, 5);
  // Days 26-30 are the newest, and those are the `expected` ones.
  assert.equal(stats.fails, 0);
  assert.equal(stats.lastSeen, '2026-08-30T00:00:00.000Z');
});

test('lastPassed is the most recent run that produced a pass', () => {
  const runs = [
    run(1, [record('expected')]),
    run(5, [record('unexpected', [attempt({ status: 'failed' })])]),
  ];
  const stats = flakeStats(runs, KEY);
  assert.equal(stats.lastPassed, '2026-08-01T00:00:00.000Z');
  assert.equal(stats.neverPassed, false);
});

test('a test that has never passed says so, which is an autofix veto upstream', () => {
  const failing = record('unexpected', [attempt({ status: 'failed' })]);
  const stats = flakeStats([run(1, [failing]), run(2, [failing])], KEY);
  assert.equal(stats.neverPassed, true);
  assert.equal(stats.lastPassed, undefined);
});

test('sites are counted and ordered by frequency', () => {
  const withSite = (site: string): TestRecord =>
    record('unexpected', [
      attempt({
        status: 'failed',
        failure: {
          kind: 'presence-timeout',
          message: 'x',
          siteFingerprint: site,
          errorFingerprint: `${site}-e`,
          taxonomyVersion: 1,
          attachments: [],
        },
      }),
    ]);
  const stats = flakeStats(
    [run(1, [withSite('aaa')]), run(2, [withSite('bbb')]), run(3, [withSite('aaa')])],
    KEY,
  );
  assert.deepEqual(stats.sites, [
    { siteFingerprint: 'aaa', count: 2 },
    { siteFingerprint: 'bbb', count: 1 },
  ]);
});

test('another test’s history is not this test’s history', () => {
  const other: TestRecord = { ...record('unexpected'), testKey: 'bbbbbbbbbbbbbbbb' };
  assert.equal(flakeStats([run(1, [other])], KEY).runs, 0);
});
