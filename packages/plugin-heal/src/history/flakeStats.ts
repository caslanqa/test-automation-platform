/**
 * Flake arithmetic over run records. Pure, so the subtle parts are testable.
 *
 * Two counting rules carry the whole thing, and both are places a naive implementation goes wrong:
 *
 * 1. **A test that did not run is not a pass.** Counting "runs where the test is absent" as passes is
 *    the classic flake-rate bug: a test that is skipped on most runs looks perfectly stable.
 * 2. **`interrupted` is absence of evidence.** Ctrl-C or `maxFailures` stopping the run says nothing
 *    about the test, so it is excluded from both the numerator and the denominator.
 *
 * And one that the shipped appium report gets wrong: a test that failed then passed on retry is
 * **one** test with outcome `flaky`, not one failure plus one pass.
 *
 * @example
 * flakeStats(runs, '9f2a1c04e5b6d7a8'); // → { runs: 18, fails: 3, flakeRate: 0.167, … }
 */
import type { RunRecord, TestRecord } from '../types.js';

export interface FlakeStats {
  /** Runs in which the test actually produced a verdict. */
  runs: number;
  /** Runs whose final outcome was a failure. */
  fails: number;
  /** Runs whose outcome was `flaky` — failed, then passed on a retry. */
  flakyRuns: number;
  /** `(fails + flakyRuns) / runs` — how often this test did not simply pass. */
  flakeRate: number;
  /** Of the runs where it failed at least once, the share that recovered on a retry. */
  recoveryRate: number;
  firstSeen?: string;
  lastSeen?: string;
  lastPassed?: string;
  /** True when the test has never produced a pass — there is no green state to heal back to. */
  neverPassed: boolean;
  /** Site fingerprints seen, most frequent first. */
  sites: Array<{ siteFingerprint: string; count: number }>;
}

const EMPTY: FlakeStats = {
  runs: 0,
  fails: 0,
  flakyRuns: 0,
  flakeRate: 0,
  recoveryRate: 0,
  neverPassed: true,
  sites: [],
};

/** Did this record produce a verdict we may count? */
function counts(record: TestRecord): boolean {
  if (record.outcome === 'skipped') {
    return false;
  }
  // Every attempt interrupted means the run was cut short, not that the test behaved.
  return !record.attempts.every(attempt => attempt.status === 'interrupted');
}

export interface FlakeStatsOptions {
  /** How many of the most recent runs to consider. */
  window?: number;
}

export function flakeStats(
  runs: readonly RunRecord[],
  testKey: string,
  options: FlakeStatsOptions = {},
): FlakeStats {
  const window = options.window ?? 20;
  // Newest first, so the window keeps recent history rather than whatever happens to be on disk.
  const ordered = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const seen: Array<{ run: RunRecord; record: TestRecord }> = [];
  for (const run of ordered) {
    const record = run.tests.find(test => test.testKey === testKey);
    if (record !== undefined && counts(record)) {
      seen.push({ run, record });
      if (seen.length >= window) {
        break;
      }
    }
  }

  if (seen.length === 0) {
    return { ...EMPTY, sites: [] };
  }

  let fails = 0;
  let flakyRuns = 0;
  let lastPassed: string | undefined;
  const siteCounts = new Map<string, number>();

  for (const { run, record } of seen) {
    if (record.outcome === 'unexpected') {
      fails += 1;
    } else if (record.outcome === 'flaky') {
      flakyRuns += 1;
    }
    // `expected` covers both a plain pass and a `test.fail()` test that failed as intended.
    if (record.outcome === 'expected' || record.outcome === 'flaky') {
      if (lastPassed === undefined || run.startedAt > lastPassed) {
        lastPassed = run.startedAt;
      }
    }
    for (const attempt of record.attempts) {
      const site = attempt.failure?.siteFingerprint;
      if (site !== undefined) {
        siteCounts.set(site, (siteCounts.get(site) ?? 0) + 1);
      }
    }
  }

  const stamps = seen.map(entry => entry.run.startedAt).sort();
  const failedRuns = fails + flakyRuns;

  return {
    runs: seen.length,
    fails,
    flakyRuns,
    flakeRate: failedRuns / seen.length,
    recoveryRate: failedRuns === 0 ? 0 : flakyRuns / failedRuns,
    firstSeen: stamps[0],
    lastSeen: stamps[stamps.length - 1],
    lastPassed,
    neverPassed: lastPassed === undefined,
    sites: [...siteCounts.entries()]
      .map(([siteFingerprint, count]) => ({ siteFingerprint, count }))
      .sort((a, b) => b.count - a.count || a.siteFingerprint.localeCompare(b.siteFingerprint)),
  };
}
