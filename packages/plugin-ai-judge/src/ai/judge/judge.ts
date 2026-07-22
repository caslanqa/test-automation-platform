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
import type { JudgeInput, JudgeVerdict } from '../types.js';
import {
  COMPARE_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  buildUserText,
  collectImages,
} from './judgePrompt.js';

/** Normalize any thrown value to a readable string. */
function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Require something to judge against: a rubric (rubric mode) or a reference image (compare mode). */
function validateJudgeInput(input: JudgeInput): void {
  const hasRubric = input.rubric !== undefined && input.rubric.length > 0;
  const hasReference = input.referenceImage !== undefined;
  if (!hasRubric && !hasReference) {
    throw new Error(
      '[ai-judge] provide a `rubric` (rubric mode) or a `referenceImage` (compare mode) — neither was given.',
    );
  }
  if (hasReference && input.image === undefined) {
    throw new Error(
      '[ai-judge] compare mode needs an actual `image` to compare against `referenceImage`.',
    );
  }
}

/**
 * Grade a chatbot response (and optionally an image) against a rubric using an LLM judge.
 *
 * Model selection is automatic and discovery-first. Complexity of the input maps to a tier
 * (simple/medium/complex); the tier resolves to a concrete model from whatever Ollama has
 * installed (ranked by size), pinned overrides in aiJudgeConfig.tierModels, or — only when no
 * compatible local model exists — a cloud model discovered from the 9Router gateway. Precedence:
 * `input.model` > `input.tier` > env `JUDGE_MODEL` > automatic.
 *
 * Determinism: temperature is 0 everywhere; name a model (input.model / JUDGE_MODEL) to pin the
 * judge for reproducible CI. Set `verbose: true` to attach a routing trace as `verdict._meta`.
 *
 * @param input The user message, bot response, rubric, and optional image / model / tier / verbose.
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

  const systemPrompt = input.referenceImage !== undefined ? COMPARE_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const userText = buildUserText(input);
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

    try {
      const verdict = await getProvider(candidate).judge(
        toApiModel(candidate),
        systemPrompt,
        userText,
        images,
      );
      return input.verbose
        ? { ...verdict, _meta: { ...plan.meta, selectedModel: candidate.id } }
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
