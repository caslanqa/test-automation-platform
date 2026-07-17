import type { TestInfo } from '@playwright/test';
import { expect as baseExpect, test } from '@playwright/test';

import { judgeResponse } from '@utils/aiJudge';
import type { JudgeInput, JudgeVerdict, ModelTier } from '@utils/types';

/** Either a raw judging input (judged on the spot) or an already-computed verdict (reused as-is). */
export type AiExpectArg = JudgeInput | JudgeVerdict;

/** Per-call model routing overrides, applied only when judging a JudgeInput (not a verdict). */
export interface JudgeOverrides {
  /** Pin an exact model for this assertion (bypasses auto-routing). */
  model?: string;
  /** Force a tier for this assertion. */
  tier?: ModelTier;
}

/** Options for the `toPassRubric` matcher. */
export interface PassRubricOptions extends JudgeOverrides {
  /** Also require the verdict score to be at least this value. */
  minScore?: number;
}

/** A value is a verdict when it carries the judge's pass/score fields; otherwise it is an input. */
function isVerdict(value: AiExpectArg): value is JudgeVerdict {
  return (
    typeof (value as JudgeVerdict).pass === 'boolean' &&
    typeof (value as JudgeVerdict).score === 'number'
  );
}

/**
 * Resolve the argument to a verdict: judge an input (applying any per-call model/tier overrides),
 * or return a verdict unchanged. Overrides on an already-computed verdict are a usage error — the
 * model was chosen when it was judged — so fail loudly rather than silently ignore them.
 */
async function toVerdict(
  value: AiExpectArg,
  overrides: JudgeOverrides = {}
): Promise<JudgeVerdict> {
  if (isVerdict(value)) {
    if (overrides.model !== undefined || overrides.tier !== undefined) {
      throw new Error(
        '[expectAi] model/tier options apply only when judging a JudgeInput; the value passed is an ' +
          'already-computed verdict. Pass model/tier to judgeResponse() or expectAi(input) instead.'
      );
    }
    return value;
  }
  return judgeResponse({
    // Default `verbose` on so the reported judgement carries routing (`_meta.selectedModel`, tier);
    // an explicit `verbose` in the input still wins.
    verbose: true,
    ...value,
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides.tier !== undefined ? { tier: overrides.tier } : {}),
  });
}

/** The current TestInfo, or `undefined` when a matcher runs outside a test (guarded). */
function currentTestInfo(): TestInfo | undefined {
  try {
    return test.info();
  } catch {
    return undefined;
  }
}

/**
 * Render a verdict as PLAIN TEXT for the report attachment. Plain text (not markdown) is deliberate:
 * the Playwright HTML report renders a `text/plain` attachment INLINE, so the score and reasoning are
 * readable directly under the step without opening/downloading anything.
 */
function renderVerdict(verdict: JudgeVerdict): string {
  const lines = [`Result: ${verdict.pass ? 'pass' : 'fail'}`, `Score: ${verdict.score}/100`];
  if (verdict._meta) {
    lines.push(`Model: ${verdict._meta.selectedModel} (tier ${verdict._meta.tier})`);
  }
  lines.push(`Reasoning: ${verdict.reasoning || '(none)'}`);
  return lines.join('\n');
}

/**
 * Resolve the argument to a verdict (judging an input, or reusing a verdict), then surface it in the
 * report as an "AI judgement" step — **on both pass and fail** — with the score in the step title and
 * the full verdict (reasoning + routing) attached under it. This is what makes a failed AI assertion
 * explainable in the report, not just in the terminal error. No-ops the reporting when there is no
 * active test (e.g. a matcher used in a script), still returning the verdict.
 */
async function judgeAndReport(
  value: AiExpectArg,
  overrides: JudgeOverrides = {}
): Promise<JudgeVerdict> {
  const verdict = await toVerdict(value, overrides);
  const info = currentTestInfo();
  if (info) {
    await test.step(`AI judgement — ${verdict.pass ? 'pass' : 'fail'} (score ${verdict.score})`, async () => {
      await info.attach('ai-judgement', {
        body: renderVerdict(verdict),
        contentType: 'text/plain',
      });
    });
  }
  return verdict;
}

/**
 * `expectAi` — Playwright's `expect` extended with AI-judge matchers.
 *
 * Every matcher accepts EITHER a {@link JudgeInput} (judged on the spot) OR a {@link JudgeVerdict}
 * (reused as-is, so several assertions on one verdict cost a single judge call). Failure messages
 * surface the judge's own reasoning. Matchers are async — always `await` them. `.not` and
 * `expect.soft` work as usual.
 *
 * @example
 * // One-liner: judge and assert in a single call.
 * await expectAi({ userMessage, botResponse, rubric }).toPassRubric({ minScore: 80 });
 *
 * @example
 * // Judge once, assert many: reuse the verdict across matchers.
 * const verdict = await judgeResponse(input);
 * await expectAi(verdict).toPassRubric();
 * await expectAi(verdict).toScoreAtLeast(80);
 *
 * @example
 * // Negative case.
 * await expectAi({ userMessage, botResponse, rubric }).not.toPassRubric();
 */
export const expectAi = baseExpect.extend({
  /** Assert the material satisfies the rubric (optionally also meeting a minimum score). */
  async toPassRubric(received: AiExpectArg, options: PassRubricOptions = {}) {
    const assertionName = 'toPassRubric';
    const verdict = await judgeAndReport(received, { model: options.model, tier: options.tier });
    const scoreOk = options.minScore === undefined || verdict.score >= options.minScore;
    // Positive-sense result; Playwright inverts it for `.not` — do not flip here.
    const pass = verdict.pass && scoreOk;

    const expected =
      options.minScore === undefined ? 'pass' : `pass and score >= ${options.minScore}`;
    const actual = `${verdict.pass ? 'pass' : 'fail'} (score ${verdict.score})`;
    const message = () =>
      `${this.utils.matcherHint(assertionName, undefined, undefined, { isNot: this.isNot })}\n\n` +
      `Expected: ${this.isNot ? 'not ' : ''}${expected}\n` +
      `Received: ${actual}\n` +
      `Reasoning: ${verdict.reasoning}`;

    return { pass, message, name: assertionName, expected, actual };
  },

  /** Assert the verdict's score is at least `threshold`. */
  async toScoreAtLeast(received: AiExpectArg, threshold: number, options: JudgeOverrides = {}) {
    const assertionName = 'toScoreAtLeast';
    const verdict = await judgeAndReport(received, options);
    // Positive-sense result; Playwright inverts it for `.not` — do not flip here.
    const pass = verdict.score >= threshold;

    const message = () =>
      `${this.utils.matcherHint(assertionName, undefined, String(threshold), { isNot: this.isNot })}\n\n` +
      `Expected score: ${this.isNot ? '< ' : '>= '}${threshold}\n` +
      `Received score: ${verdict.score}\n` +
      `Reasoning: ${verdict.reasoning}`;

    return { pass, message, name: assertionName, expected: threshold, actual: verdict.score };
  },

  /**
   * Assert the received input's actual `image` matches the given reference image (compare mode).
   * The received value must be a JudgeInput carrying `image` — a precomputed verdict cannot be
   * re-judged. Pass a `rubric` in the input to focus the comparison; `options` accepts minScore /
   * model / tier.
   * @example await expectAi({ image: actualShot }).toMatchImage(expectedLogo, { minScore: 90 });
   */
  async toMatchImage(
    received: AiExpectArg,
    expected: string | Buffer,
    options: PassRubricOptions = {}
  ) {
    const assertionName = 'toMatchImage';
    if (isVerdict(received)) {
      throw new Error(
        '[expectAi] toMatchImage needs a JudgeInput carrying the actual `image`, not a verdict.'
      );
    }

    const verdict = await judgeAndReport(
      { ...received, referenceImage: expected },
      { model: options.model, tier: options.tier }
    );
    const scoreOk = options.minScore === undefined || verdict.score >= options.minScore;
    // Positive-sense result; Playwright inverts it for `.not` — do not flip here.
    const pass = verdict.pass && scoreOk;

    const expectedText =
      options.minScore === undefined
        ? 'match reference'
        : `match reference (score >= ${options.minScore})`;
    const actual = `${verdict.pass ? 'match' : 'mismatch'} (score ${verdict.score})`;
    const message = () =>
      `${this.utils.matcherHint(assertionName, undefined, undefined, { isNot: this.isNot })}\n\n` +
      `Expected: ${this.isNot ? 'not ' : ''}${expectedText}\n` +
      `Received: ${actual}\n` +
      `Reasoning: ${verdict.reasoning}`;

    return { pass, message, name: assertionName, expected: expectedText, actual };
  },
});
