import type { JudgeInput, JudgeVerdict, ModelTier } from '../ai/types.js';
import { judgeResponse } from '../aiJudge.js';

/** One labelled example: the material to judge plus the verdict a human gave it. */
export interface CalibrationCase {
  /** Label for the report row. */
  name?: string;
  /** What the judge is asked (rubric mode; `image` may be a file path relative to the dataset). */
  input: JudgeInput;
  /** The human verdict — `true`/`'pass'` or `false`/`'fail'`. */
  expected: boolean | 'pass' | 'fail';
}

/** How one case came out: the human label against the judge's own. */
export interface CaseResult {
  name: string;
  expected: boolean;
  actual: boolean;
  score: number;
  reasoning: string;
  /** Requirements the judge marked unmet, when it returned a checklist. */
  unmet: string[];
}

/**
 * Agreement between one judge model and the human labels. `falsePass` is the number that matters for a
 * test suite: the judge passed material a human failed, which is a green test over a real defect.
 */
export interface CalibrationReport {
  /** The model that actually judged, taken from the routing trace rather than from the request. */
  model: string;
  cases: number;
  correct: number;
  accuracy: number;
  /** Cohen's kappa — agreement corrected for what two raters would hit by chance. */
  kappa: number;
  falsePass: number;
  falseFail: number;
  results: CaseResult[];
}

/** Read a human label written either as a boolean or as 'pass'/'fail'. */
export function toExpected(value: CalibrationCase['expected']): boolean {
  return typeof value === 'boolean' ? value : value === 'pass';
}

/**
 * Cohen's kappa for two binary raters. 1 is perfect agreement, 0 is chance, negative is worse than
 * chance; with both raters unanimous on the same label, chance agreement is 1 and kappa is defined
 * here as 1 when they agree and 0 when they do not.
 * @example kappa([{ expected: true, actual: true }, { expected: false, actual: false }]); // 1
 */
export function kappa(pairs: Array<{ expected: boolean; actual: boolean }>): number {
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

/** Options for one calibration run. */
export interface CalibrateOptions {
  /** Model to judge with (bypasses auto-routing); omit to use whatever the router picks. */
  model?: string;
  /** Tier to force instead of a model. */
  tier?: ModelTier;
  /** Judge each case this many times and take the majority (measures what sampling buys). */
  samples?: number;
  /** Judge each case with every one of these models and take the majority. */
  jury?: string[];
  /** Called after each case, for progress output. */
  onCase?: (result: CaseResult, index: number, total: number) => void;
}

/**
 * Judge every labelled case with one model and report how well it agreed with the humans. Cases run in
 * order (the Ollama gate serializes local calls anyway) and go through the normal verdict cache, so a
 * second run of an unchanged dataset is free.
 * @example const report = await calibrate(cases, { model: 'local/qwen3.5:9b' });
 */
export async function calibrate(
  cases: CalibrationCase[],
  options: CalibrateOptions = {},
): Promise<CalibrationReport> {
  const results: CaseResult[] = [];
  // The model that actually judged, read off the routing trace: a report headed 'auto' hides the one
  // thing it exists to state, and an env JUDGE_MODEL decides the model without appearing in options.
  let judged: string | undefined;

  for (const [index, entry] of cases.entries()) {
    const verdict: JudgeVerdict = await judgeResponse({
      ...entry.input,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.tier === undefined ? {} : { tier: options.tier }),
      ...(options.samples === undefined ? {} : { samples: options.samples }),
      ...(options.jury === undefined ? {} : { jury: options.jury }),
      verbose: true,
    });
    judged ??= verdict._meta?.selectedModel;
    const result: CaseResult = {
      name: entry.name ?? `case ${index + 1}`,
      expected: toExpected(entry.expected),
      actual: verdict.pass,
      score: verdict.score,
      reasoning: verdict.reasoning,
      unmet: (verdict.criteria ?? []).filter(item => !item.met).map(item => item.criterion),
    };
    results.push(result);
    options.onCase?.(result, index, cases.length);
  }

  const correct = results.filter(result => result.expected === result.actual).length;

  return {
    model: options.model ?? judged ?? options.tier ?? 'auto',
    cases: results.length,
    correct,
    accuracy: results.length === 0 ? 0 : correct / results.length,
    kappa: kappa(results),
    falsePass: results.filter(result => result.actual && !result.expected).length,
    falseFail: results.filter(result => !result.actual && result.expected).length,
    results,
  };
}
