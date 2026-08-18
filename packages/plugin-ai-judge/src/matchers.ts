import type { TestInfo } from '@playwright/test';
import { expect as baseExpect, test } from '@playwright/test';

import type { JudgeInput, JudgeVerdict, ModelTier } from './ai/types.js';
import { judgeResponse } from './aiJudge.js';

/** Either a raw judging input (judged on the spot) or an already-computed verdict (reused as-is). */
export type AiExpectArg = JudgeInput | JudgeVerdict;

/** Per-call model routing overrides, applied only when judging a JudgeInput (not a verdict). */
export interface JudgeOverrides {
  /** Pin an exact model for this assertion (bypasses auto-routing). */
  model?: string;
  /** Force a tier for this assertion. */
  tier?: ModelTier;
  /**
   * Judge this many times and take a strict majority — for an assertion that sits on the borderline.
   * @example await expectAi(input).toPassRubric({ samples: 3 });
   */
  samples?: number;
  /**
   * Judge with each of these models and take a strict majority (a tie fails).
   * @example await expectAi(input).toPassRubric({ jury: ['local/qwen3.5:4b', 'local/llama3.1'] });
   */
  jury?: string[];
}

/** Options for the `toPassRubric` matcher. */
export interface PassRubricOptions extends JudgeOverrides {
  /** Also require the verdict score to be at least this value. */
  minScore?: number;
}

/** Options for the `toMatchImage` matcher. */
export interface MatchImageOptions extends PassRubricOptions {
  /**
   * Judge both orders — actual first, then reference first — and require the same answer. A verdict
   * that flips when the two images swap places is position bias, not a match. Costs a second call.
   * @example await expectAi({ image: shot }).toMatchImage(golden, { strict: true });
   */
  strict?: boolean;
}

/** A value is a verdict when it carries the judge's pass/score fields; otherwise it is an input. */
function isVerdict(value: AiExpectArg): value is JudgeVerdict {
  return (
    typeof (value as JudgeVerdict).pass === 'boolean' &&
    typeof (value as JudgeVerdict).score === 'number'
  );
}

/**
 * Resolve the argument to a verdict: judge an input (applying any per-call judging overrides), or
 * return a verdict unchanged. Overrides on an already-computed verdict are a usage error — the model
 * was chosen when it was judged — so fail loudly rather than silently ignore them.
 */
async function toVerdict(
  value: AiExpectArg,
  overrides: JudgeOverrides = {},
): Promise<JudgeVerdict> {
  const given = Object.entries(overrides).filter(([, option]) => option !== undefined);
  if (isVerdict(value)) {
    if (given.length > 0) {
      throw new Error(
        `[expectAi] ${given.map(([name]) => name).join('/')} apply only when judging a JudgeInput; the ` +
          'value passed is an already-computed verdict. Pass them to judgeResponse() or expectAi(input) instead.',
      );
    }
    return value;
  }

  return judgeResponse({
    // Default `verbose` on so the reported judgement carries routing (`_meta.selectedModel`, tier);
    // an explicit `verbose` in the input still wins.
    verbose: true,
    ...value,
    ...Object.fromEntries(given),
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
    const cached = verdict._meta.cached === true ? ', cached' : '';
    lines.push(`Model: ${verdict._meta.selectedModel} (tier ${verdict._meta.tier}${cached})`);
    if (verdict._meta.votes !== undefined && verdict._meta.agreement !== undefined) {
      const agreeing = Math.round(verdict._meta.agreement * verdict._meta.votes);
      lines.push(
        `Votes: ${agreeing}/${verdict._meta.votes} agreed on ${verdict.pass ? 'pass' : 'fail'}`,
      );
    }
    if (verdict._meta.calls !== undefined) {
      const seconds = ((verdict._meta.latencyMs ?? 0) / 1000).toFixed(1);
      lines.push(
        verdict._meta.calls === 0
          ? 'Cost: 0 calls (replayed from cache)'
          : `Cost: ${verdict._meta.calls} call${verdict._meta.calls === 1 ? '' : 's'}, ${seconds}s`,
      );
    }
  }
  if (verdict.criteria && verdict.criteria.length > 0) {
    const met = verdict.criteria.filter(item => item.met).length;
    lines.push(`Criteria: ${met}/${verdict.criteria.length} met`);
    for (const item of verdict.criteria) {
      lines.push(`  ${item.met ? '✓' : '✗'} ${item.criterion}${item.why ? ` — ${item.why}` : ''}`);
    }
  }
  lines.push(`Reasoning: ${verdict.reasoning || '(none)'}`);

  return lines.join('\n');
}

/** The judging overrides out of a matcher's options — `minScore` and `strict` are the matcher's own. */
function overridesOf(options: PassRubricOptions | MatchImageOptions): JudgeOverrides {
  return {
    model: options.model,
    tier: options.tier,
    samples: options.samples,
    jury: options.jury,
  };
}

/** The failing criteria, for the assertion message — a failure that names them needs no report. */
function unmetLine(verdict: JudgeVerdict, label = 'Unmet'): string {
  const unmet = (verdict.criteria ?? []).filter(item => !item.met);

  return unmet.length === 0 ? '' : `\n${label}: ${unmet.map(item => item.criterion).join('; ')}`;
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
  overrides: JudgeOverrides = {},
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
 * Merge the two image orders of a strict comparison: a match needs both to agree, and the score is
 * the lower of the two. Disagreement is reported as what it is — an order-dependent verdict.
 */
function combineSwapped(first: JudgeVerdict, swapped: JudgeVerdict): JudgeVerdict {
  const agree = first.pass === swapped.pass;
  const both = `actual-first: ${first.reasoning} | reference-first: ${swapped.reasoning}`;

  return {
    pass: agree && first.pass,
    score: Math.min(first.score, swapped.score),
    reasoning: agree
      ? both
      : `Order-dependent verdict (position bias): actual-first ${first.pass ? 'match' : 'mismatch'} ` +
        `(${first.score}), reference-first ${swapped.pass ? 'match' : 'mismatch'} (${swapped.score}). ${both}`,
    ...(first._meta === undefined ? {} : { _meta: first._meta }),
  };
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
 *
 * @example
 * // Hallucination check: every claim must come from the retrieved context.
 * await expectAi({ userMessage, botResponse }).toBeGroundedIn(retrievedChunks);
 */
export const expectAi = baseExpect.extend({
  /** Assert the material satisfies the rubric (optionally also meeting a minimum score). */
  async toPassRubric(received: AiExpectArg, options: PassRubricOptions = {}) {
    const assertionName = 'toPassRubric';
    const verdict = await judgeAndReport(received, overridesOf(options));
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
      `Reasoning: ${verdict.reasoning}${unmetLine(verdict)}`;

    return { pass, message, name: assertionName, expected, actual };
  },

  /**
   * Assert every factual claim in the response is supported by `context` — the hallucination check for
   * a RAG or knowledge-base bot. Each claim becomes a criterion, so a failure names the unsupported
   * one; `minScore` accepts a share of supported claims instead of all of them. This is the mode that
   * asks most of the judge — a 4B model graded coverage instead of support and produced both a false
   * pass and a false fail where a 9B model scored every case right — so calibrate yours.
   * @example await expectAi({ botResponse }).toBeGroundedIn(retrievedChunks);
   */
  async toBeGroundedIn(
    received: AiExpectArg,
    context: string | string[],
    options: PassRubricOptions = {},
  ) {
    const assertionName = 'toBeGroundedIn';
    if (isVerdict(received)) {
      throw new Error(
        '[expectAi] toBeGroundedIn needs a JudgeInput carrying the response to check, not a verdict.',
      );
    }

    const verdict = await judgeAndReport({ ...received, context }, overridesOf(options));
    const scoreOk = options.minScore === undefined || verdict.score >= options.minScore;
    // Positive-sense result; Playwright inverts it for `.not` — do not flip here.
    const pass = verdict.pass && scoreOk;

    const supported = (verdict.criteria ?? []).filter(item => item.met).length;
    const claims = verdict.criteria?.length ?? 0;
    const expected =
      options.minScore === undefined
        ? 'every claim supported by the context'
        : `claims supported by the context (score >= ${options.minScore})`;
    const actual =
      claims === 0
        ? `${verdict.pass ? 'grounded' : 'ungrounded'} (score ${verdict.score})`
        : `${supported}/${claims} claims supported (score ${verdict.score})`;
    const message = () =>
      `${this.utils.matcherHint(assertionName, undefined, undefined, { isNot: this.isNot })}\n\n` +
      `Expected: ${this.isNot ? 'not ' : ''}${expected}\n` +
      `Received: ${actual}\n` +
      `Reasoning: ${verdict.reasoning}${unmetLine(verdict, 'Unsupported')}`;

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
      `Reasoning: ${verdict.reasoning}${unmetLine(verdict)}`;

    return { pass, message, name: assertionName, expected: threshold, actual: verdict.score };
  },

  /**
   * Assert the received input's actual `image` matches the given reference image (compare mode).
   * The received value must be a JudgeInput carrying `image` — a precomputed verdict cannot be
   * re-judged. Pass a `rubric` in the input to focus the comparison; `options` accepts minScore /
   * model / tier / strict (judge both image orders and require the same answer).
   * @example await expectAi({ image: actualShot }).toMatchImage(expectedLogo, { minScore: 90 });
   */
  async toMatchImage(
    received: AiExpectArg,
    expected: string | Buffer,
    options: MatchImageOptions = {},
  ) {
    const assertionName = 'toMatchImage';
    if (isVerdict(received)) {
      throw new Error(
        '[expectAi] toMatchImage needs a JudgeInput carrying the actual `image`, not a verdict.',
      );
    }
    const actualImage = received.image;
    if (actualImage === undefined) {
      throw new Error('[expectAi] toMatchImage needs the actual `image` on the received input.');
    }

    const overrides = overridesOf(options);
    const first = await judgeAndReport({ ...received, referenceImage: expected }, overrides);
    const verdict =
      options.strict === true
        ? combineSwapped(
            first,
            await judgeAndReport(
              { ...received, image: expected, referenceImage: actualImage },
              overrides,
            ),
          )
        : first;
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
      `Reasoning: ${verdict.reasoning}${unmetLine(verdict)}`;

    return { pass, message, name: assertionName, expected: expectedText, actual };
  },
});
