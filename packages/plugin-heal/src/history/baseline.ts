/**
 * `heal/flake-baseline.json` — the committed rolling aggregate, and the reason flake history outlives
 * a CI artifact.
 *
 * Raw run records live in `.heal/runs/`, which is gitignored and machine-local; in CI they survive only
 * as an artifact, and artifact retention is 90 days by default and one day on some plans. A flake rate
 * has to outlast that. So the nightly job folds the runs into per-test counters and commits **those**.
 *
 * Committing the aggregate rather than the runs keeps the file small, readable and blameable, and buys
 * the thing no store would: `git log -p heal/flake-baseline.json` answers "when did this test start
 * flaking" with no database at all.
 *
 * Merging is additive against what is already committed, because each CI machine sees only its own
 * slice of runs — recomputing from the local `.heal/runs/` alone would silently discard every counter
 * a different machine contributed.
 *
 * @example
 * const merged = foldBaseline(readRuns(runsDir), loadBaseline(projectDir).baseline);
 */
import fs from 'node:fs';
import path from 'node:path';

import { RUN_SCHEMA, type Baseline, type BaselineEntry, type RunRecord } from '../types.js';

export const BASELINE_PATH = path.join('heal', 'flake-baseline.json');

/** How many runs the counters are meant to cover. Matches the classifier's own window. */
export const BASELINE_WINDOW = 200;

/** Failure sites kept per test. Enough to see a pattern, few enough to stay readable in a diff. */
const MAX_SITES = 5;

export const EMPTY_BASELINE: Baseline = {
  schema: RUN_SCHEMA,
  window: BASELINE_WINDOW,
  entries: [],
};

export interface LoadBaselineResult {
  baseline: Baseline;
  /** Absent or unreadable. The caller reports; a broken file must not make the fold throw. */
  problem?: string;
}

export function loadBaseline(projectDir: string, file = BASELINE_PATH): LoadBaselineResult {
  const target = path.isAbsolute(file) ? file : path.join(projectDir, file);
  let raw: string;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch {
    return { baseline: { ...EMPTY_BASELINE, entries: [] } };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Baseline>;
    if (!Array.isArray(parsed.entries)) {
      return {
        baseline: { ...EMPTY_BASELINE, entries: [] },
        problem: `${file}: no 'entries' array`,
      };
    }
    return {
      baseline: {
        schema: RUN_SCHEMA,
        window: parsed.window ?? BASELINE_WINDOW,
        folded: Array.isArray(parsed.folded) ? parsed.folded : [],
        entries: parsed.entries.filter(entry => typeof entry?.testKey === 'string'),
      },
    };
  } catch (error) {
    return {
      baseline: { ...EMPTY_BASELINE, entries: [] },
      problem: `${file} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

export function saveBaseline(projectDir: string, baseline: Baseline, file = BASELINE_PATH): void {
  const target = path.isAbsolute(file) ? file : path.join(projectDir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Sorted by key: the file is read as a diff, and an unstable order would make every nightly PR look
  // like it changed everything.
  const entries = [...baseline.entries].sort((a, b) => a.testKey.localeCompare(b.testKey));
  fs.writeFileSync(target, `${JSON.stringify({ ...baseline, entries }, null, 2)}\n`);
}

const laterOf = (a: string | undefined, b: string | undefined): string | undefined =>
  a === undefined ? b : b === undefined ? a : a > b ? a : b;
const earlierOf = (a: string | undefined, b: string): string =>
  a === undefined ? b : a < b ? a : b;

/**
 * Fold runs into the committed counters.
 *
 * The counting rules are `flakeStats`'s, restated over a whole run at once rather than per test: a
 * test that did not run is not a pass, and a fully interrupted test is no evidence at all. Getting
 * either wrong here would poison every classification downstream, since this file is what the
 * classifier reads when the local runs directory is empty.
 */
export function foldBaseline(
  runs: readonly RunRecord[],
  previous: Baseline = EMPTY_BASELINE,
  options: { window?: number; runIds?: ReadonlySet<string> } = {},
): { baseline: Baseline; foldedRuns: number } {
  const byKey = new Map<string, BaselineEntry>(
    previous.entries.map(entry => [entry.testKey, { ...entry, sites: [...entry.sites] }]),
  );
  // Runs already folded in are skipped, so re-running the job does not double every counter.
  const seenRuns = new Set<string>([...(previous.folded ?? []), ...(options.runIds ?? [])]);
  const folded: string[] = [...(previous.folded ?? [])];
  let foldedRuns = 0;

  for (const run of [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    if (seenRuns.has(run.runId)) {
      continue;
    }
    foldedRuns += 1;
    folded.push(run.runId);
    for (const test of run.tests) {
      if (test.outcome === 'skipped' || test.attempts.every(a => a.status === 'interrupted')) {
        continue;
      }
      const existing = byKey.get(test.testKey);
      const entry: BaselineEntry = existing ?? {
        testKey: test.testKey,
        project: test.project,
        file: test.file,
        title: test.titlePath.join(' › '),
        runs: 0,
        fails: 0,
        passOnRetry: 0,
        firstSeen: run.startedAt,
        lastSeen: run.startedAt,
        sites: [],
      };

      entry.runs += 1;
      entry.firstSeen = earlierOf(entry.firstSeen, run.startedAt);
      entry.lastSeen = laterOf(entry.lastSeen, run.startedAt) ?? run.startedAt;
      if (test.outcome === 'unexpected') {
        entry.fails += 1;
      } else if (test.outcome === 'flaky') {
        entry.passOnRetry += 1;
        entry.lastPassed = laterOf(entry.lastPassed, run.startedAt);
      } else if (test.outcome === 'expected') {
        entry.lastPassed = laterOf(entry.lastPassed, run.startedAt);
      }
      // A rename produces a new key by design, so the title is refreshed rather than kept.
      entry.title = test.titlePath.join(' › ');
      entry.file = test.file;

      for (const attempt of test.attempts) {
        const failure = attempt.failure;
        if (failure === undefined) {
          continue;
        }
        const site = entry.sites.find(item => item.siteFingerprint === failure.siteFingerprint);
        if (site === undefined) {
          entry.sites.push({
            siteFingerprint: failure.siteFingerprint,
            count: 1,
            lastSeen: run.startedAt,
            kind: failure.kind,
          });
        } else {
          site.count += 1;
          site.lastSeen = laterOf(site.lastSeen, run.startedAt) ?? run.startedAt;
        }
      }
      entry.sites.sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen));
      entry.sites.length = Math.min(entry.sites.length, MAX_SITES);

      byKey.set(test.testKey, entry);
    }
  }

  // The window is a cap on the counters, not a cap on the entries: a test whose counters have run past
  // it is scaled down rather than dropped, so its rate survives while its weight stops growing.
  const window = options.window ?? previous.window ?? BASELINE_WINDOW;
  for (const entry of byKey.values()) {
    if (entry.runs > window) {
      const factor = window / entry.runs;
      entry.fails = Math.round(entry.fails * factor);
      entry.passOnRetry = Math.round(entry.passOnRetry * factor);
      entry.runs = window;
    }
  }

  return {
    baseline: {
      schema: RUN_SCHEMA,
      window,
      folded: folded.slice(-window),
      entries: [...byKey.values()],
    },
    foldedRuns,
  };
}
