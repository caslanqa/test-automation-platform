/**
 * @pwtap/plugin-ai-judge — LLM-as-judge matchers for Playwright.
 *
 * Extends `expect` with `toPassRubric` / `toScoreAtLeast` / `toMatchImage`, judged by a model you
 * choose (Ollama, any OpenAI-compatible endpoint, or native Claude). Merged into the project's
 * `expect` via the barrel, and also exported as `expectAi` for explicit use.
 *
 * @example
 * import { expect } from '@fixtures';
 * await expect({ userMessage, botResponse, rubric }).toPassRubric({ minScore: 80 });
 */
export { expectAi as expect, expectAi } from './matchers.js';
export type { AiExpectArg, JudgeOverrides, PassRubricOptions } from './matchers.js';

export type {
  JudgeInput,
  JudgeMeta,
  JudgeVerdict,
  ModelProfile,
  ModelTier,
  ProviderKind,
} from './ai/types.js';
export { judgeResponse } from './aiJudge.js';

export { JudgeHttpError, type AIProvider } from './ai/providers/provider.js';
export { registerProvider } from './ai/providers/registry.js';
