/**
 * The classifier: which of five things a failure is, decided from evidence and nothing else.
 *
 * | Class | Meaning | Auto-fixable |
 * |---|---|---|
 * | `flaky` | same code, same app, non-deterministic outcome | no — find the race |
 * | `locator-drift` | the element is still there and still satisfies the intent; its identifier changed | yes, with proof (a later phase) |
 * | `true-fail` | the app's behaviour or data changed | **never** |
 * | `env-infra` | harness, network, dependency or browser failed | no — re-run the job |
 * | `unknown` | evidence insufficient | no — advisory only |
 *
 * **Rule 0 outranks everything: a retry that passed means flaky.** A locator that resolved on the
 * second attempt did not change, and a value that matched on the second attempt is not a regression.
 * The official Playwright healer has no such rule, which is how it "fixes" a race by rewriting a
 * selector — and this single rule is the largest correctness gap this closes.
 *
 * Everything here is pure and deterministic. No model is consulted, and there is no seam where one
 * could quietly become required: an escalation tier can only ever narrow `unknown`, never move a
 * failure out of `true-fail` or `env-infra`.
 *
 * @example
 * classify({ outcome: 'flaky', failure: someFailure });
 * // → { class: 'flaky', confidence: 95, reasons: ['a retry passed: …'] }
 */
import type { FlakeStats } from '../history/flakeStats.js';
import type { ErrorKind, FailureRecord } from '../types.js';

export type TriageClass = 'flaky' | 'locator-drift' | 'true-fail' | 'env-infra' | 'unknown';

export interface Triage {
  class: TriageClass;
  /** 0-100. >= 85 act, 60-84 advise, < 60 ask. */
  confidence: number;
  /** Why, in the order the evidence was weighed. Shown to a human verbatim. */
  reasons: string[];
  /** Conditions that block an automatic fix even if the class allows one. */
  vetoes: string[];
  /** The full score table, so a close call is inspectable rather than mysterious. */
  scores: Record<TriageClass, number>;
}

export interface TriageInput {
  /** `TestCase.outcome()` for this test in this run. */
  outcome: 'expected' | 'unexpected' | 'flaky' | 'skipped';
  /** The failure from the last failing attempt, when there was one. */
  failure?: FailureRecord;
  /** Cross-run history. Omit when there is none — the classifier then says so and caps confidence. */
  history?: FlakeStats;
  /** True when this run reported an error outside any test. */
  hadGlobalErrors?: boolean;
  /** The test's own file changed in this change set. */
  testFileChanged?: boolean;
  /** The file in the failing stack frame (usually a page object) changed. */
  topFrameFileChanged?: boolean;
  /** Git could not answer, so no diff inference is allowed. */
  diffUnknown?: boolean;
  /** `package-lock.json` or `playwright.config.ts` changed. */
  infraFileChanged?: boolean;
  /** The config's `retries`. With 0 there is no in-run flake signal at all. */
  configRetries?: number;
}

/**
 * How each error kind moves the score.
 *
 * These are **absolute confidence points, not relative nudges** — a distinction that matters,
 * because the action bands (85 act / 60 advise) are absolute too. An earlier version treated them as
 * nudges and reconciled them with nothing, which left `locator-drift` unable to reach 85 at all: the
 * autofix bar was decoration. A single decisive reading now lands near the act band on its own, and
 * corroboration carries it over.
 */
const KIND_WEIGHTS: Record<ErrorKind, Partial<Record<TriageClass, number>>> = {
  // A selector that was unique no longer is: the DOM demonstrably changed.
  'strict-mode': { 'locator-drift': 70 },
  'presence-timeout': { 'locator-drift': 60 },
  'action-timeout': { 'locator-drift': 60 },
  // The matcher compared two values and they differ. About as certain as this engine gets, and the
  // one class that must never be healed.
  'value-mismatch': { 'true-fail': 85 },
  // Genuinely ambiguous: the element may be gone, or the list may be legitimately empty. Equal
  // weights are the point — the margin then reports it as the close call it is.
  'count-zero': { 'locator-drift': 25, 'true-fail': 25 },
  network: { 'env-infra': 80 },
  'browser-crash': { 'env-infra': 85 },
  'fixture-error': { 'env-infra': 65 },
  // Mobile. The element was there and then was not — the tree changed while the command was in
  // flight, which is what a race looks like from the driver's side.
  'stale-element': { flaky: 70 },
  // Mobile. Found but unusable: an overlay, an animation still running, or a control the app has
  // disabled. Equal weights because those readings are genuinely equally likely, and the margin then
  // reports it as the close call it is. Never drift — the locator resolved.
  'not-interactable': { flaky: 30, 'true-fail': 30 },
  // Mobile. The driver said outright that it cannot perform this gesture. As certain as a value
  // mismatch, and equally not a defect anything can repair.
  'driver-unsupported': { 'true-fail': 90 },
  // The weakest signal there is: something took too long and said nothing else.
  'test-timeout': {},
  unknown: {},
};

/** Which class "nothing in the repository changed" reinforces, per error kind. */
const APP_MOVED_FAVOURS: Partial<Record<ErrorKind, TriageClass>> = {
  'strict-mode': 'locator-drift',
  'presence-timeout': 'locator-drift',
  'action-timeout': 'locator-drift',
  'value-mismatch': 'true-fail',
  // An unchanged repository plus an element that will not accept input means the app disabled it.
  'not-interactable': 'true-fail',
  'stale-element': 'flaky',
  // Nothing about the repository bears on a driver's capabilities; without this entry the generic
  // "something outside changed" branch would nudge it toward drift.
  'driver-unsupported': 'true-fail',
};

const ZERO: Record<TriageClass, number> = {
  flaky: 0,
  'locator-drift': 0,
  'true-fail': 0,
  'env-infra': 0,
  unknown: 0,
};

export function classify(input: TriageInput): Triage {
  const scores: Record<TriageClass, number> = { ...ZERO };
  const reasons: string[] = [];
  const vetoes: string[] = [];
  const add = (klass: TriageClass, points: number, why: string): void => {
    scores[klass] += points;
    reasons.push(why);
  };

  // ---- Rule 0: the in-run retry outcome, which outranks every other signal ------------------
  if (input.outcome === 'flaky') {
    return {
      class: 'flaky',
      confidence: 95,
      reasons: [
        'a retry of this test passed in the same run — the code and the app did not change between attempts, so this is intermittent',
      ],
      vetoes: ['not-locator-drift'],
      scores: { ...scores, flaky: 95 },
    };
  }

  const failure = input.failure;
  if (failure === undefined) {
    return {
      class: 'unknown',
      confidence: 0,
      reasons: ['no failure was recorded for this test'],
      vetoes: ['no-failure'],
      scores,
    };
  }

  // ---- Rule 1: the error taxonomy -----------------------------------------------------------
  const weights = KIND_WEIGHTS[failure.kind];
  for (const [klass, points] of Object.entries(weights) as Array<[TriageClass, number]>) {
    add(klass, points, `the error is ${failure.kind}`);
  }
  if (Object.keys(weights).length === 0) {
    reasons.push(`the error is ${failure.kind}, which does not point anywhere on its own`);
  }
  // A value matcher that reported both sides has compared them. Never heal that, whatever else says.
  if (failure.kind === 'value-mismatch') {
    vetoes.push('value-mismatch: the expected value is the test doing its job');
  }
  // The driver found the element and then failed for another reason. Whatever is wrong, the locator
  // is not — so there is nothing here a replacement could fix, and offering one would repoint a
  // correct locator at some other element that happens to be interactable.
  if (failure.kind === 'not-interactable' || failure.kind === 'stale-element') {
    vetoes.push('locator-resolved: the element was found, so the locator is not the problem');
  }
  if (failure.kind === 'driver-unsupported') {
    vetoes.push('driver-unsupported: a capability gap is a human decision, not a repair');
  }
  if (input.hadGlobalErrors === true) {
    add('env-infra', 25, 'this run reported an error outside any test, so the harness was unwell');
  }

  // ---- Rule 2: cross-run history ------------------------------------------------------------
  const history = input.history;
  if (history === undefined || history.runs === 0) {
    reasons.push('no cross-run history: flake rate unavailable');
    vetoes.push('no-history');
  } else {
    if (history.flakeRate > 0.05 && history.flakeRate < 0.95) {
      add(
        'flaky',
        70,
        `this test failed in ${Math.round(history.flakeRate * 100)}% of the last ${history.runs} runs it ran in, and passed in the rest`,
      );
    }
    if (history.recoveryRate > 0.3) {
      add(
        'flaky',
        25,
        `${Math.round(history.recoveryRate * 100)}% of its failures recovered on a retry`,
      );
    }
    if (history.flakeRate === 1 && history.lastPassed !== undefined) {
      add('locator-drift', 15, `it has failed every run since ${history.lastPassed}`);
      add('true-fail', 15, 'a deterministic change, not an intermittent one');
    }
    if (history.neverPassed) {
      add(
        'unknown',
        30,
        'this test has never passed, so there is no green state to compare against',
      );
      vetoes.push('never-passed: nothing to be equivalent to');
    }
  }
  if (input.configRetries === 0) {
    reasons.push('retries are 0 in this config, so an in-run flake signal was impossible');
  }

  // ---- Rule 3: what changed -----------------------------------------------------------------
  if (input.diffUnknown === true) {
    reasons.push('git could not report what changed, so nothing is inferred from the diff');
  } else {
    if (input.testFileChanged === true) {
      add('true-fail', 35, 'this test file was edited in this change');
      vetoes.push('test-file-edited: a human just changed this spec');
    }
    if (input.topFrameFileChanged === true) {
      add('true-fail', 30, 'the file in the failing stack frame was edited in this change');
      vetoes.push('source-edited: the code under the failure just changed');
    }
    if (input.infraFileChanged === true) {
      add('env-infra', 20, 'the lockfile or the Playwright config changed in this change');
    }
    if (
      input.testFileChanged === false &&
      input.topFrameFileChanged === false &&
      history?.lastPassed !== undefined
    ) {
      // "The application moved" reinforces whichever reading the error already supports — it does
      // NOT argue for a moved element on its own. A value mismatch with an unchanged repository is
      // the app changing behaviour, which is the opposite conclusion.
      const favoured = APP_MOVED_FAVOURS[failure.kind];
      if (favoured === undefined) {
        add('locator-drift', 12, 'nothing in the repository changed, so something outside it did');
        add('true-fail', 12, 'which could be the element or the behaviour');
      } else {
        add(
          favoured,
          25,
          favoured === 'true-fail'
            ? 'nothing in the repository changed, so the application changed behaviour'
            : 'nothing in the repository changed, so the application moved',
        );
      }
    }
  }

  // ---- Decide -------------------------------------------------------------------------------
  const ranked = (Object.entries(scores) as Array<[TriageClass, number]>)
    .filter(([klass]) => klass !== 'unknown')
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const [winner, winnerScore] = ranked[0];
  const runnerUp = ranked[1]?.[1] ?? 0;

  if (winnerScore === 0) {
    return {
      class: 'unknown',
      confidence: 0,
      reasons,
      vetoes: [...vetoes, 'no-signal'],
      scores,
    };
  }

  // The margin, not the raw score: 95-vs-5 is a confident call, 40-vs-38 is not, and a number that
  // ignored the runner-up would report both as the same. Because the weights above are absolute,
  // no fudge term is needed — a lone decisive reading already scores near the act band.
  let confidence = Math.max(0, Math.min(100, winnerScore - runnerUp));
  if (history === undefined || history.runs === 0) {
    // Without history the classifier is reading one run. Say so by refusing to act on it.
    confidence = Math.min(confidence, 70);
  }
  if (winner !== 'locator-drift') {
    vetoes.push('not-locator-drift');
  }

  return { class: winner, confidence, reasons, vetoes, scores };
}

/**
 * Classes the evidence leaves open, for the escalation tier to intersect a model's answer with.
 *
 * Derived rather than stored, so it cannot go stale against the vetoes it reads. Every repair-blocking
 * veto rules out exactly one class — `locator-drift`, because that is the only class a repair acts on —
 * so this is where "a model cannot turn a value mismatch into something repairable" is enforced. That is
 * the same direction `falseHeal` is gated at zero for, and it must hold whatever a page's text says.
 *
 * @example
 * candidateClasses(triage).includes('locator-drift'); // false once a value mismatch was seen
 */
export function candidateClasses(triage: Pick<Triage, 'vetoes'>): TriageClass[] {
  const blocked = triage.vetoes.some(veto =>
    /^(value-mismatch|never-passed|test-file-edited|source-edited|locator-resolved|driver-unsupported)/.test(
      veto,
    ),
  );
  return blocked
    ? ['flaky', 'true-fail', 'env-infra']
    : ['flaky', 'locator-drift', 'true-fail', 'env-infra'];
}

/** The action band a confidence falls into, matching `mobile-core`'s 75/45 house style at the top end. */
export function band(confidence: number): 'act' | 'advise' | 'ask' {
  if (confidence >= 85) {
    return 'act';
  }
  return confidence >= 60 ? 'advise' : 'ask';
}
