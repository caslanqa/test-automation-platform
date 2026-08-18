/** Majority rules for a sampled or panel verdict: a tie fails, and the split is stated. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { aggregateVerdicts } from '../src/ai/judge/vote.js';
import type { JudgeMeta, JudgeVerdict } from '../src/ai/types.js';

const meta = (model: string): JudgeMeta => ({
  selectedModel: model,
  tier: 'simple',
  score: 0,
  needsVision: false,
  reasons: [],
  source: 'input.model',
});

const vote = (pass: boolean, score: number, model = 'local/a'): JudgeVerdict => ({
  pass,
  score,
  reasoning: `${pass ? 'met' : 'unmet'} by ${model}`,
  _meta: meta(model),
});

test('a single verdict is returned untouched', () => {
  const only = vote(true, 90);
  assert.equal(aggregateVerdicts([only]), only);
});

test('a strict majority decides, and the median is the score', () => {
  const verdict = aggregateVerdicts([vote(true, 100), vote(true, 80), vote(false, 30)]);
  assert.equal(verdict.pass, true);
  assert.equal(verdict.score, 80);
  assert.match(verdict.reasoning, /^Judges 2\/3 → pass\./);
  assert.deepEqual([verdict._meta?.votes, verdict._meta?.agreement], [3, 2 / 3]);
});

test('a tie fails — judges disagreeing is not evidence the material is right', () => {
  const verdict = aggregateVerdicts([vote(true, 100), vote(false, 0)]);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.score, 50);
  assert.match(verdict.reasoning, /Judges 1\/2 → fail/);
});

test('a unanimous vote reports no split', () => {
  const verdict = aggregateVerdicts([vote(false, 20), vote(false, 40)]);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.score, 30);
  assert.equal(verdict.reasoning, 'unmet by local/a');
});

test('the reasoning and checklist come from a voter on the winning side', () => {
  const failing: JudgeVerdict = {
    ...vote(false, 33),
    criteria: [{ criterion: 'states 9am', met: false, why: 'said 6pm' }],
  };
  const verdict = aggregateVerdicts([vote(true, 100), failing, vote(false, 33)]);
  assert.equal(verdict.pass, false);
  assert.deepEqual(verdict.criteria, failing.criteria);
});

test('a panel names every model that voted', () => {
  const verdict = aggregateVerdicts([
    vote(true, 90, 'local/a'),
    vote(true, 70, 'local/b'),
    vote(false, 10, 'local/a'),
  ]);
  assert.equal(verdict._meta?.selectedModel, 'local/a, local/b');
});

test('aggregating nothing is a usage error, not an empty verdict', () => {
  assert.throws(() => aggregateVerdicts([]), /no verdicts to aggregate/);
});
