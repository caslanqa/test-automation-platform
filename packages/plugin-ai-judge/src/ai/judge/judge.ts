import { aiJudgeConfig } from '../../config/aiJudge.config.js';

import { getRegistry } from '../registry/providerRegistry.js';
import { analyzeComplexity } from '../router/complexityAnalyzer.js';
import {
  getProvider,
  isRetryable,
  noModelError,
  planSelection,
  toApiModel,
} from '../router/modelRouter.js';
import type { JudgeInput, JudgeVerdict, ModelProfile } from '../types.js';
import {
  REPAIR_HINT,
  buildSystemPrompt,
  buildUserText,
  collectImages,
  createNonce,
  modeOf,
  responseUnderTest,
} from './judgePrompt.js';
import { cacheKey, readCached, writeCached } from './verdictCache.js';
import { VerdictParseError } from './verdictParser.js';
import { aggregateVerdicts } from './vote.js';

/** Normalize any thrown value to a readable string. */
function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Require something to judge against, and the material each mode needs to judge. */
function validateJudgeInput(input: JudgeInput): void {
  const hasRubric = input.rubric !== undefined && input.rubric.length > 0;
  const hasReference = input.referenceImage !== undefined;
  const hasContext = input.context !== undefined;
  if (!hasRubric && !hasReference && !hasContext) {
    throw new Error(
      '[ai-judge] provide a `rubric` (rubric mode), a `referenceImage` (compare mode) or a `context` ' +
        '(grounded mode) — none was given.',
    );
  }
  if (hasReference && input.image === undefined) {
    throw new Error(
      '[ai-judge] compare mode needs an actual `image` to compare against `referenceImage`.',
    );
  }
  if (hasContext && responseUnderTest(input) === undefined) {
    throw new Error(
      '[ai-judge] grounded mode needs the answer under test — pass `botResponse`, or a `conversation` ' +
        'whose last assistant turn is it.',
    );
  }
}

/**
 * Judge once, and once more with a blunter reminder when the reply carried no JSON. Small local models
 * occasionally answer in prose despite constrained decoding, and a second ask is cheaper than failing
 * a test on formatting.
 */
async function judgeWithRepair(
  candidate: ModelProfile,
  systemPrompt: string,
  userText: string,
  images: Array<string | Buffer>,
): Promise<JudgeVerdict> {
  const provider = getProvider(candidate);
  const model = toApiModel(candidate);
  try {
    return await provider.judge(model, systemPrompt, userText, images);
  } catch (error) {
    if (!(error instanceof VerdictParseError)) {
      throw error;
    }
    console.warn(`[ai-judge] ${candidate.id} did not return JSON; asking once more`);

    return provider.judge(model, systemPrompt, `${userText}\n\n${REPAIR_HINT}`, images);
  }
}

/** One judgement of the material. `sample` separates repeat samples in the cache; 0 is the first. */
async function judgeOnce(input: JudgeInput, sample: number): Promise<JudgeVerdict> {
  const nonce = createNonce();
  const systemPrompt = buildSystemPrompt(
    modeOf(input),
    nonce,
    input.referenceAnswer !== undefined && input.referenceAnswer.length > 0,
  );
  const userText = buildUserText(input, nonce);
  const images = collectImages(input);
  const complexity = analyzeComplexity(input, aiJudgeConfig);
  const registry = await getRegistry(aiJudgeConfig);
  const plan = planSelection(input, complexity, registry, aiJudgeConfig);

  const autoSelected = plan.meta.source === 'auto' || plan.meta.source === 'input.tier';
  const attempts: Array<{ id: string; error: string }> = [];

  for (let i = 0; i < plan.candidates.length; i++) {
    const candidate = plan.candidates[i];
    const isLast = i === plan.candidates.length - 1;

    // A paid cloud model chosen automatically (no compatible local) must never be silent.
    if (autoSelected && candidate.provider === 'openai') {
      console.warn(
        `[ai-judge] using cloud model ${candidate.id} (billable) — no compatible local model for tier '${plan.meta.tier}'`,
      );
    }

    const key = cacheKey(candidate, input, sample);
    const cached = readCached(key);
    if (cached !== undefined) {
      return input.verbose
        ? {
            ...cached,
            _meta: {
              ...plan.meta,
              selectedModel: candidate.id,
              cached: true,
              calls: 0,
              latencyMs: 0,
            },
          }
        : cached;
    }

    try {
      const started = Date.now();
      const verdict = await judgeWithRepair(candidate, systemPrompt, userText, images);
      const latencyMs = Date.now() - started;
      writeCached(key, verdict, input);

      return input.verbose
        ? {
            ...verdict,
            _meta: { ...plan.meta, selectedModel: candidate.id, calls: 1, latencyMs },
          }
        : verdict;
    } catch (error) {
      attempts.push({ id: candidate.id, error: errText(error) });
      if (!isLast && isRetryable(error)) {
        console.warn(
          `[ai-judge] ${candidate.id} unavailable (${errText(error)}); trying next candidate`,
        );
        continue;
      }
      throw error;
    }
  }

  // No candidates at all (no compatible local model and no reachable cloud model).
  throw noModelError(plan.meta.tier, complexity.needsVision, registry, attempts);
}

/**
 * Grade a chatbot response (and optionally an image) against a rubric using an LLM judge.
 *
 * Model selection is automatic and discovery-first. Complexity of the input maps to a tier
 * (simple/medium/complex); the tier resolves to a concrete model from whatever Ollama has
 * installed (ranked by size, judge-tuned models first), pinned overrides in aiJudgeConfig.tierModels,
 * or — only when no compatible local model exists — a cloud model discovered from the 9Router gateway.
 * Precedence: `input.model` > `input.tier` > env `JUDGE_MODEL` > automatic.
 *
 * Determinism: temperature is 0 everywhere and every verdict is cached under `.judge/cache` keyed by
 * model + material, so a re-run replays the same judgement at no cost (`JUDGE_CACHE=off` to disable).
 * `samples` / `jury` judge several times and take a strict majority — a tie fails. Set `verbose: true`
 * to attach the routing trace (and the vote split) as `verdict._meta`.
 *
 * @param input The user message, bot response, rubric, and optional image / model / tier / samples /
 * jury / verbose.
 * @returns The parsed pass/fail verdict.
 * @example
 * <code>
 * const verdict = await judgeResponse({
 *   userMessage: 'What time do you open?',
 *   botResponse: 'We open at 9am every day.',
 *   rubric: 'Must state the store opens at 9am.',
 * });
 * expect(verdict.pass, verdict.reasoning).toBeTruthy();
 * </code>
 */
export async function judgeResponse(input: JudgeInput): Promise<JudgeVerdict> {
  validateJudgeInput(input);

  const samples = Math.max(1, Math.round(input.samples ?? 1));
  const voters = input.jury !== undefined && input.jury.length > 0 ? input.jury : [input.model];
  if (voters.length === 1 && samples === 1) {
    return judgeOnce(input, 0);
  }

  const verdicts: JudgeVerdict[] = [];
  for (const model of voters) {
    for (let sample = 0; sample < samples; sample++) {
      // verbose while voting: the aggregate needs each voter's model to name the panel.
      verdicts.push(
        await judgeOnce(
          { ...input, ...(model === undefined ? {} : { model }), verbose: true },
          sample,
        ),
      );
    }
  }

  const aggregate = aggregateVerdicts(verdicts);

  return input.verbose
    ? aggregate
    : {
        pass: aggregate.pass,
        score: aggregate.score,
        reasoning: aggregate.reasoning,
        ...(aggregate.criteria === undefined ? {} : { criteria: aggregate.criteria }),
      };
}
