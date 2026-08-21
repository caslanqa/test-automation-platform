/**
 * Grading the classifier against human labels.
 *
 * Mirrors `plugin-ai-judge`'s calibration deliberately — accuracy, Cohen's kappa, and a directional
 * error count that is gated at zero — because the shape is the same problem: an automated judgement
 * whose mistakes are not symmetric.
 *
 * **`falseHeal` is the `MAX_FALSE_PASS=0` of this engine.** Calling a `true-fail` a `locator-drift` is
 * how a green suite becomes a lie, and it is the one error that must never be traded for accuracy.
 * `falseBug` — the opposite mistake — is reported and NOT gated: over-reporting a regression is noisy,
 * not dangerous, and gating both directions equally would push the classifier toward repairing more.
 *
 * @example
 * const report = calibrateTriage(cases);
 * report.kappa; // the number the gate keys on, not accuracy
 */
import type { FlakeStats } from '../history/flakeStats.js';
import { confusion, kappaMulti, type ConfusionRow } from '../metrics/kappaMulti.js';
import { classify, type Triage, type TriageClass } from '../triage/classify.js';
import { siteFingerprint } from '../triage/fingerprint.js';
import { TAXONOMY_VERSION, type FailureRecord } from '../types.js';
import type { CaseEvidence, LabelledCase } from './dataset.js';

export interface CaseResult {
  name: string;
  expected: TriageClass;
  actual: TriageClass;
  confidence: number;
  correct: boolean;
  reasons: string[];
  /** Vetoes the case demanded that the classifier did not produce. Each one is a lost guard. */
  missingVetoes: string[];
  note?: string;
}

export interface CalibrationReport {
  cases: number;
  correct: number;
  accuracy: number;
  /** Cohen's kappa over the five classes — what the gate keys on. */
  kappa: number;
  /** A regression classified as something repairable. The error that must never happen. */
  falseHeal: number;
  /** A repairable drift or a flake classified as a regression. Noisy, not dangerous. */
  falseBug: number;
  /** Cases whose demanded veto did not fire. Gated at zero: a lost veto is a heal nobody blocked. */
  missingVeto: number;
  /** Per-class counts, so a report can name which class is being confused. */
  confusion: Array<ConfusionRow<TriageClass>>;
  /** The taxonomy the run was graded against, so an old report is not compared with a new one. */
  taxonomyVersion: number;
  results: CaseResult[];
}

/** Build the `FailureRecord` shape `classify()` expects from a hand-written case. */
function failureOf(evidence: CaseEvidence): FailureRecord | undefined {
  if (evidence.kind === undefined) {
    return undefined;
  }
  return {
    kind: evidence.kind,
    matcher: evidence.matcher,
    locatorCode: evidence.locatorCode,
    expected: evidence.expectedValue,
    received: evidence.receivedValue,
    message: evidence.message ?? '',
    siteFingerprint: siteFingerprint({
      kind: evidence.kind,
      matcher: evidence.matcher,
      locatorCode: evidence.locatorCode,
    }),
    errorFingerprint: 'calibration',
    taxonomyVersion: TAXONOMY_VERSION,
    attachments: [],
    failingStep:
      evidence.failingStepCategory === undefined
        ? undefined
        : { title: 'calibration', category: evidence.failingStepCategory },
  };
}

function historyOf(evidence: CaseEvidence): FlakeStats | undefined {
  const history = evidence.history;
  if (history === undefined) {
    return undefined;
  }
  return {
    runs: history.runs,
    fails: Math.round(history.flakeRate * history.runs),
    flakyRuns: 0,
    flakeRate: history.flakeRate,
    recoveryRate: history.recoveryRate ?? 0,
    neverPassed: history.neverPassed ?? false,
    lastPassed: history.lastPassed ?? (history.neverPassed === true ? undefined : 'seen'),
    sites: [],
  };
}

/** Run one case through the real classifier — no reimplementation, or the grade means nothing. */
export function classifyCase(entry: LabelledCase): Triage {
  const evidence = entry.evidence;
  return classify({
    outcome: evidence.outcome,
    failure: failureOf(evidence),
    history: historyOf(evidence),
    hadGlobalErrors: evidence.hadGlobalErrors,
    testFileChanged: evidence.testFileChanged,
    topFrameFileChanged: evidence.topFrameFileChanged,
    diffUnknown: evidence.diffUnknown,
    infraFileChanged: evidence.infraFileChanged,
    configRetries: evidence.configRetries,
  });
}

/** Classes a repair may be attempted on. Anything landing here that should not is a false heal. */
const REPAIRABLE = new Set<TriageClass>(['locator-drift']);

export function calibrateTriage(cases: readonly LabelledCase[]): CalibrationReport {
  const results: CaseResult[] = cases.map(entry => {
    const triage = classifyCase(entry);
    return {
      name: entry.name,
      expected: entry.expected,
      actual: triage.class,
      confidence: triage.confidence,
      correct: triage.class === entry.expected,
      reasons: triage.reasons,
      missingVetoes: (entry.expectedVetoes ?? []).filter(
        wanted => !triage.vetoes.some(veto => veto.includes(wanted)),
      ),
      note: entry.note,
    };
  });

  const pairs = results.map(result => ({ expected: result.expected, actual: result.actual }));
  const correct = results.filter(result => result.correct).length;

  return {
    cases: results.length,
    correct,
    accuracy: results.length === 0 ? 0 : correct / results.length,
    kappa: kappaMulti(pairs),
    falseHeal: results.filter(
      result => result.expected === 'true-fail' && REPAIRABLE.has(result.actual),
    ).length,
    falseBug: results.filter(
      result =>
        (result.expected === 'locator-drift' || result.expected === 'flaky') &&
        result.actual === 'true-fail',
    ).length,
    missingVeto: results.filter(result => result.missingVetoes.length > 0).length,
    confusion: confusion(pairs),
    taxonomyVersion: TAXONOMY_VERSION,
    results,
  };
}

export interface CalibrationGates {
  minAccuracy?: number;
  minKappa?: number;
  maxFalseHeal?: number;
  maxMissingVeto?: number;
}

/**
 * The shipped thresholds.
 *
 * `minAccuracy` is 85 rather than the judge's 90: triage is five classes with a real `unknown` base
 * rate, and 90 on a small multi-class set gates on noise. `minKappa` 0.7 is "substantial" on
 * Landis-Koch and is the gate that actually protects, because accuracy alone is inflated by the
 * dominant class.
 */
export const GATE_DEFAULTS: Required<CalibrationGates> = {
  minAccuracy: 0.85,
  minKappa: 0.7,
  maxFalseHeal: 0,
  maxMissingVeto: 0,
};

export function gateCalibration(report: CalibrationReport, gates: CalibrationGates = {}): string[] {
  const { minAccuracy, minKappa, maxFalseHeal, maxMissingVeto } = { ...GATE_DEFAULTS, ...gates };
  const failures: string[] = [];
  if (report.accuracy < minAccuracy) {
    failures.push(
      `accuracy ${(report.accuracy * 100).toFixed(1)}% < ${(minAccuracy * 100).toFixed(1)}%`,
    );
  }
  if (report.kappa < minKappa) {
    failures.push(`kappa ${report.kappa.toFixed(2)} < ${minKappa}`);
  }
  if (report.falseHeal > maxFalseHeal) {
    failures.push(
      `${report.falseHeal} regression(s) classified as repairable > ${maxFalseHeal} — this is how a green suite becomes a lie`,
    );
  }
  if (report.missingVeto > maxMissingVeto) {
    failures.push(
      `${report.missingVeto} case(s) lost a veto the dataset demanded > ${maxMissingVeto} — the class is advice, the veto is what actually blocks a repair`,
    );
  }
  return failures;
}
