/**
 * Was the healing any good? Pure functions over the heal log and the run history.
 *
 * **The mask rate is the metric that matters.** Precision measures whether a heal stuck; the mask rate
 * measures whether it hid something, and one masked bug costs more than every heal ever saved. So its
 * gate defaults to zero and it is detected three ways, two of which are heuristics and say so.
 *
 * **A correction to the plan's second detector.** It called for "the same `siteFingerprint` later
 * failed with a value mismatch". That cannot work: the site fingerprint includes the locator code, and
 * healing changes exactly that — so the post-heal failure necessarily has a different fingerprint. The
 * comparison that does hold is the same test failing at the same **line** with a value mismatch, which
 * is the observable form of "we repointed a locator and now a value assertion there disagrees".
 *
 * `healRecall` is reported and deliberately **not gated**: its denominator is our own classifier, so
 * early on it measures our optimism rather than reality, and gating it would push the engine toward
 * repairing more.
 *
 * @example
 * healMetrics({ heals, runs, quarantine, now: Date.now() }).maskRate;
 */
import { flakeStats } from '../history/flakeStats.js';
import type { QuarantineEntry } from '../quarantine/file.js';
import type { RunRecord } from '../types.js';
import { currentHeals, type HealLogEntry } from './healLog.js';

/** Runs after a heal in which it must not have regressed, before precision counts it as survived. */
export const DEFAULT_SURVIVAL_RUNS = 10;
/** Below this many applied heals, precision is undefined rather than a small-sample verdict. */
export const MIN_APPLIED_FOR_PRECISION = 10;

export type MaskDetector =
  'reverted-as-masking' | 'value-mismatch-at-the-healed-line' | 'heal-no-longer-in-place';

export interface MaskedHeal {
  healId: string;
  title: string;
  file: string;
  line: number;
  detectors: MaskDetector[];
}

export interface HealMetrics {
  applied: number;
  /** Heals with no later failure at their site, over the survival window. */
  survived: number;
  /** Heals whose site failed again within the window. */
  regressed: number;
  /** `survived / (survived + regressed)`, or undefined below the sample floor. */
  precision?: number;
  /** Applied over eligible — reported, never gated. Eligible is our own classifier's opinion. */
  recall?: number;
  eligible: number;
  masked: MaskedHeal[];
  /** `masked / applied`. Zero applied heals means zero, not undefined: nothing was hidden. */
  maskRate: number;
  /** Median hours from a site's first failure to the heal that addressed it. */
  medianTimeToHealHours?: number;
  /** Mean flake rate over the recent window against the window before it. */
  flakeRateTrend?: { recent: number; previous: number; delta: number };
  quarantine: { size: number; oldestAgeDays: number; expired: number; netAdded7d: number };
  /** Lines of the heal log that could not be parsed. */
  unreadableLogLines: number;
}

export interface HealMetricsInput {
  heals: readonly HealLogEntry[];
  /** Newest first, as `readRuns` returns them. */
  runs: readonly RunRecord[];
  quarantine: readonly QuarantineEntry[];
  now: number;
  survivalRuns?: number;
  /** Lines the log reader could not parse, carried through so a report can say so. */
  unreadableLogLines?: number;
  /** Heals whose locator is no longer in the spec, keyed by healId — from `healsRemoved`. */
  removed?: ReadonlyMap<string, boolean>;
  /** Window for the flake-rate trend, in runs. */
  trendWindow?: number;
}

const DAY = 86_400_000;
const median = (values: number[]): number | undefined => {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

/** Runs that started strictly after a heal was applied, oldest first. */
function runsAfter(runs: readonly RunRecord[], at: string): RunRecord[] {
  return runs
    .filter(run => run.startedAt > at)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function healMetrics(input: HealMetricsInput): HealMetrics {
  const { runs, quarantine, now } = input;
  const heals = currentHeals(input.heals).filter(entry => entry.triage !== undefined);
  const applied = heals.length;
  const survivalRuns = input.survivalRuns ?? DEFAULT_SURVIVAL_RUNS;

  let survived = 0;
  let regressed = 0;
  const masked: MaskedHeal[] = [];
  const timesToHeal: number[] = [];

  for (const heal of heals) {
    const later = runsAfter(runs, heal.at).slice(0, survivalRuns);

    // Did the thing it was healing fail again? The site fingerprint still identifies the OLD failure,
    // so a recurrence of it means the repair did not hold.
    const recurred = later.some(run =>
      run.tests.some(
        test =>
          test.testKey === heal.testKey &&
          test.attempts.some(attempt => attempt.failure?.siteFingerprint === heal.siteFingerprint),
      ),
    );
    if (recurred) {
      regressed += 1;
    } else if (later.length > 0) {
      survived += 1;
    }

    // --- mask detection ------------------------------------------------------------------------
    const detectors: MaskDetector[] = [];

    // Ground truth: a human said so.
    if (heal.revertReason === 'masked-bug' || heal.revertReason === 'wrong-element') {
      detectors.push('reverted-as-masking');
    }

    // Heuristic, and the strongest signal available: the same test now reports a VALUE mismatch at
    // the line the heal edited. We repointed a locator and an assertion there began to disagree,
    // which is what pointing at the wrong element looks like from the outside.
    const valueMismatchThere = later.some(run =>
      run.tests.some(
        test =>
          test.testKey === heal.testKey &&
          test.attempts.some(
            attempt =>
              attempt.failure?.kind === 'value-mismatch' &&
              attempt.failure.topFrame?.file === heal.file &&
              attempt.failure.topFrame.line === heal.line,
          ),
      ),
    );
    if (valueMismatchThere) {
      detectors.push('value-mismatch-at-the-healed-line');
    }

    // Heuristic: the locator the heal wrote is gone from the spec, so somebody took it back out.
    if (input.removed?.get(heal.healId) === true) {
      detectors.push('heal-no-longer-in-place');
    }

    if (detectors.length > 0) {
      masked.push({
        healId: heal.healId,
        title: heal.title,
        file: heal.file,
        line: heal.line,
        detectors,
      });
    }

    // Time to heal: from the first run in which this site failed to the moment it was applied.
    const firstFailure = [...runs]
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .find(run =>
        run.tests.some(
          test =>
            test.testKey === heal.testKey &&
            test.attempts.some(
              attempt => attempt.failure?.siteFingerprint === heal.siteFingerprint,
            ),
        ),
      );
    if (firstFailure !== undefined) {
      const hours = (Date.parse(heal.at) - Date.parse(firstFailure.startedAt)) / 3_600_000;
      if (hours >= 0) {
        timesToHeal.push(hours);
      }
    }
  }

  // Eligible: failures our own classifier called locator-drift in the act band. Named as a proxy in
  // the docs, because it is the classifier grading its own homework.
  const eligible = runs.reduce(
    (count, run) =>
      count +
      run.tests.filter(test =>
        test.attempts.some(
          attempt =>
            attempt.failure?.kind === 'presence-timeout' || attempt.failure?.kind === 'strict-mode',
        ),
      ).length,
    0,
  );

  const decided = survived + regressed;
  const trend = flakeRateTrend(runs, input.trendWindow ?? 20);

  const expired = quarantine.filter(entry => Date.parse(entry.expiresAt) <= now).length;
  const netAdded7d = quarantine.filter(entry => now - Date.parse(entry.addedAt) <= 7 * DAY).length;

  return {
    applied,
    survived,
    regressed,
    precision: applied >= MIN_APPLIED_FOR_PRECISION && decided > 0 ? survived / decided : undefined,
    recall: eligible === 0 ? undefined : applied / eligible,
    eligible,
    masked,
    maskRate: applied === 0 ? 0 : masked.length / applied,
    medianTimeToHealHours: median(timesToHeal),
    flakeRateTrend: trend,
    quarantine: {
      size: quarantine.length,
      oldestAgeDays: quarantine.reduce(
        (max, entry) => Math.max(max, Math.floor((now - Date.parse(entry.addedAt)) / DAY)),
        0,
      ),
      expired,
      netAdded7d,
    },
    unreadableLogLines: input.unreadableLogLines ?? 0,
  };
}

/**
 * Mean flake rate over the most recent `window` runs against the `window` before them.
 *
 * The direction matters more than the value: an engine whose precision climbs while the suite's flake
 * rate climbs too is treating symptoms.
 */
export function flakeRateTrend(
  runs: readonly RunRecord[],
  window = 20,
): { recent: number; previous: number; delta: number } | undefined {
  const ordered = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (ordered.length < 2) {
    return undefined;
  }
  const recentRuns = ordered.slice(0, window);
  const previousRuns = ordered.slice(window, window * 2);
  if (previousRuns.length === 0) {
    return undefined;
  }

  const meanRate = (slice: RunRecord[]): number => {
    const keys = [...new Set(slice.flatMap(run => run.tests.map(test => test.testKey)))];
    if (keys.length === 0) {
      return 0;
    }
    const rates = keys.map(key => flakeStats(slice, key, { window: slice.length }).flakeRate);
    return rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
  };

  const recent = meanRate(recentRuns);
  const previous = meanRate(previousRuns);
  return { recent, previous, delta: recent - previous };
}
