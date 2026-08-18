/**
 * @pwtap/plugin-ai-judge — LLM-as-judge matchers for Playwright.
 *
 * Extends `expect` with `toPassRubric` / `toScoreAtLeast` / `toMatchImage` / `toBeGroundedIn`, judged by
 * a model you choose (Ollama, any OpenAI-compatible endpoint, or native Claude). Merged into the
 * project's `expect` via the barrel, and also exported as `expectAi` for explicit use.
 *
 * @example
 * import { expect } from '@fixtures';
 * await expect({ userMessage, botResponse, rubric }).toPassRubric({ minScore: 80 });
 */
export { expectAi as expect, expectAi } from './matchers.js';
export type {
  AiExpectArg,
  JudgeOverrides,
  MatchImageOptions,
  PassRubricOptions,
} from './matchers.js';

export type {
  ConversationTurn,
  Criterion,
  JudgeInput,
  JudgeMeta,
  JudgeMode,
  JudgeVerdict,
  ModelProfile,
  ModelTier,
  ProviderKind,
} from './ai/types.js';
export { judgeResponse } from './aiJudge.js';

export { calibrate, kappa } from './calibrate/calibrate.js';
export type {
  CalibrateOptions,
  CalibrationCase,
  CalibrationReport,
  CaseResult,
} from './calibrate/calibrate.js';
export { loadDataset } from './calibrate/dataset.js';
export { harvestCases, harvestToDataset } from './calibrate/harvest.js';
export type { HarvestResult, HarvestedCase } from './calibrate/harvest.js';

export { JudgeHttpError, type AIProvider } from './ai/providers/provider.js';
export { registerProvider } from './ai/providers/registry.js';
