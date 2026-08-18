/** Local tier assignment: a judge-tuned model takes the pool, and size buckets apply inside it. */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { analyzeComplexity } from '../src/ai/router/complexityAnalyzer.js';
import { planSelection } from '../src/ai/router/modelRouter.js';
import type { ModelProfile, RegistrySnapshot } from '../src/ai/types.js';
import { aiJudgeConfig } from '../src/config/aiJudge.config.js';

const local = (id: string, paramsB: number): ModelProfile => ({
  id,
  provider: 'ollama',
  supportsVision: false,
  paramsB,
});

const snapshot = (models: ModelProfile[]): RegistrySnapshot => ({
  models,
  fetchedAt: Date.now(),
  errors: [],
});

const INPUT = { rubric: 'Must state 9am.', botResponse: 'We open at 9am.' };

const plan = (registry: RegistrySnapshot, tier: 'simple' | 'complex') =>
  planSelection(
    { ...INPUT, tier },
    analyzeComplexity(INPUT, aiJudgeConfig),
    registry,
    aiJudgeConfig,
  ).candidates.map(candidate => candidate.id);

beforeEach(() => {
  delete process.env.JUDGE_MODEL; // an env pin would short-circuit tier selection
});

test('without a judge-tuned model, tiers still map onto parameter size', () => {
  const registry = snapshot([local('local/small:1b', 1), local('local/big:70b', 70)]);
  assert.deepEqual(plan(registry, 'simple'), ['local/small:1b']);
  assert.deepEqual(plan(registry, 'complex'), ['local/big:70b']);
});

test('an installed judge-tuned model wins over a much larger generalist', () => {
  const registry = snapshot([local('local/qwen3.5:70b', 70), local('local/selene-mini:8b', 8)]);
  assert.deepEqual(plan(registry, 'complex'), ['local/selene-mini:8b']);
  assert.deepEqual(plan(registry, 'simple'), ['local/selene-mini:8b']);
});

test('with several judge-tuned models, the size buckets apply among those', () => {
  const registry = snapshot([
    local('local/qwen3.5:70b', 70),
    local('local/prometheus:7b', 7),
    local('local/selene-mini:8b', 8),
  ]);
  assert.deepEqual(plan(registry, 'simple'), ['local/prometheus:7b']);
  assert.deepEqual(plan(registry, 'complex'), ['local/selene-mini:8b']);
});
