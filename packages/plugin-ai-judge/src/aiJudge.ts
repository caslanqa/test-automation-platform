/**
 * Backward-compatible entry point. The judge implementation moved to ./ai/* (split into prompt,
 * parser, providers, registry, router, and this orchestrator). This thin re-export keeps existing
 * `@utils/aiJudge` imports — used by tests and docs — working unchanged.
 */
export { judgeResponse } from './ai/judge/judge.js';
export type { JudgeInput, JudgeVerdict, ModelTier } from './ai/types.js';
