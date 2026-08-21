/**
 * Drafting labelled cases from real runs, so the dataset is this project's failures rather than
 * somebody's imagination.
 *
 * Two rules borrowed from `plugin-ai-judge`'s harvest, both of which decide whether the dataset is
 * worth having:
 *
 * - **dedupe by site**, or a suite with one chronic failure produces fifty copies of it;
 * - **uncertainty first**, so the human reads the cases the classifier was least sure about. Reading
 *   the confident ones teaches nobody anything.
 *
 * The drafted `expected` is the classifier's own answer, which is a starting point and a trap: it must
 * be reviewed, and the note says so in the file itself.
 *
 * @example
 * harvestCases(runs, { limit: 20 }); // → cases ready for a human to correct
 */
import { flakeStats } from '../history/flakeStats.js';
import { classify } from '../triage/classify.js';
import { lastFailure } from '../triage/run.js';
import type { RunRecord } from '../types.js';
import type { CaseEvidence, LabelledCase } from './dataset.js';

export const REVIEW_NOTE =
  "DRAFTED by `heal calibrate --harvest`: `expected` is the classifier's own answer. Review each one and correct it — a case that agrees with the classifier by construction grades nothing.";

export interface HarvestOptions {
  limit?: number;
  /** Sites already in the dataset, so a second harvest does not re-draft them. */
  known?: ReadonlySet<string>;
}

/** How far a reading is from being decisive: 0 is a coin flip, 100 is certain. */
const uncertainty = (confidence: number): number => Math.abs(confidence - 100);

export function harvestCases(
  runs: readonly RunRecord[],
  options: HarvestOptions = {},
): LabelledCase[] {
  const limit = options.limit ?? 20;
  const known = options.known ?? new Set<string>();
  const bySite = new Map<string, LabelledCase & { uncertainty: number }>();

  for (const run of runs) {
    for (const test of run.tests) {
      if (test.outcome !== 'unexpected' && test.outcome !== 'flaky') {
        continue;
      }
      const failure = lastFailure(test.attempts);
      const site = failure?.siteFingerprint ?? `no-failure:${test.testKey}`;
      if (known.has(site) || bySite.has(site)) {
        continue;
      }

      const history = flakeStats(
        runs.filter(candidate => candidate.runId !== run.runId),
        test.testKey,
      );
      const evidence: CaseEvidence = {
        outcome: test.outcome,
        kind: failure?.kind,
        matcher: failure?.matcher,
        locatorCode: failure?.locatorCode,
        expectedValue: failure?.expected,
        receivedValue: failure?.received,
        message: failure?.message,
        failingStepCategory: failure?.failingStep?.category,
        history:
          history.runs === 0
            ? undefined
            : {
                runs: history.runs,
                flakeRate: history.flakeRate,
                recoveryRate: history.recoveryRate,
                neverPassed: history.neverPassed,
                lastPassed: history.lastPassed,
              },
        hadGlobalErrors: run.globalErrors.length > 0,
        configRetries: run.configRetries,
        // Whether the diff changed anything is not recoverable from a stored run, and inventing it
        // would grade the classifier against a fact that was never observed.
        diffUnknown: true,
      };

      const triage = classify({
        outcome: test.outcome,
        failure,
        history: history.runs === 0 ? undefined : history,
        hadGlobalErrors: run.globalErrors.length > 0,
        diffUnknown: true,
        configRetries: run.configRetries,
      });

      bySite.set(site, {
        name: `${test.file} › ${test.titlePath.join(' › ')}`,
        source: `run ${run.runId} (${run.startedAt})`,
        evidence,
        expected: triage.class,
        note: REVIEW_NOTE,
        uncertainty: uncertainty(triage.confidence),
      });
    }
  }

  return [...bySite.values()]
    .sort((a, b) => b.uncertainty - a.uncertainty || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ uncertainty: _uncertainty, ...entry }) => entry);
}
