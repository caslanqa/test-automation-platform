/** Cache keys must ignore the per-call nonce but split on anything that changes the judgement. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { cacheKey, readCached, writeCached } from '../src/ai/judge/verdictCache.js';
import type { JudgeInput } from '../src/ai/types.js';

const INPUT: JudgeInput = {
  userMessage: 'What time do you open?',
  botResponse: 'We open at 9am every day.',
  rubric: 'Must state the store opens at 9am.',
};

let cwd: string;
let temp: string;

beforeEach(() => {
  cwd = process.cwd();
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-cache-'));
  process.chdir(temp);
  delete process.env.JUDGE_CACHE;
});

afterEach(() => {
  process.chdir(cwd);
  fs.rmSync(temp, { recursive: true, force: true });
});

test('the same model and material yield the same key', () => {
  assert.equal(cacheKey('local/qwen3.5:9b', INPUT), cacheKey('local/qwen3.5:9b', { ...INPUT }));
});

test('a different model, response, rubric or mode yields a different key', () => {
  const base = cacheKey('local/qwen3.5:9b', INPUT);
  assert.notEqual(base, cacheKey('local/qwen3.5:4b', INPUT));
  assert.notEqual(
    base,
    cacheKey('local/qwen3.5:9b', { ...INPUT, botResponse: 'We open at 10am.' }),
  );
  assert.notEqual(base, cacheKey('local/qwen3.5:9b', { ...INPUT, rubric: 'Must state 10am.' }));
  assert.notEqual(
    cacheKey('m', { image: Buffer.from('a'), rubric: 'r' }),
    cacheKey('m', { image: Buffer.from('a'), referenceImage: Buffer.from('a'), rubric: 'r' }),
  );
});

test('repeat samples of one input get their own keys, and sample 0 keeps the old key', () => {
  const base = cacheKey('local/qwen3.5:9b', INPUT);
  assert.equal(cacheKey('local/qwen3.5:9b', INPUT, 0), base);
  assert.notEqual(cacheKey('local/qwen3.5:9b', INPUT, 1), base);
  assert.notEqual(cacheKey('local/qwen3.5:9b', INPUT, 2), cacheKey('local/qwen3.5:9b', INPUT, 1));
});

test('context, a reference answer and a conversation all take part in the key', () => {
  const base = cacheKey('m', INPUT);
  assert.notEqual(base, cacheKey('m', { ...INPUT, context: 'Opening hours: 9am.' }));
  assert.notEqual(base, cacheKey('m', { ...INPUT, referenceAnswer: 'We open at 9am.' }));
  assert.notEqual(
    base,
    cacheKey('m', { ...INPUT, conversation: [{ role: 'user', content: 'hi' }] }),
  );
  assert.notEqual(
    cacheKey('m', { ...INPUT, context: 'a' }),
    cacheKey('m', { ...INPUT, context: 'b' }),
  );
});

test('images take part in the key', () => {
  assert.notEqual(
    cacheKey('m', { rubric: 'r', image: Buffer.from('one') }),
    cacheKey('m', { rubric: 'r', image: Buffer.from('two') }),
  );
});

test('a written verdict is replayed without its routing trace', () => {
  const key = cacheKey('local/qwen3.5:9b', INPUT);
  assert.equal(readCached(key), undefined);

  writeCached(key, {
    pass: true,
    score: 91,
    reasoning: 'states 9am',
    _meta: {
      selectedModel: 'local/qwen3.5:9b',
      tier: 'simple',
      score: 0,
      needsVision: false,
      reasons: [],
      source: 'auto',
    },
  });
  assert.deepEqual(readCached(key), { pass: true, score: 91, reasoning: 'states 9am' });
});

test('the checklist survives a round trip', () => {
  const key = cacheKey('local/qwen3.5:9b', { ...INPUT, rubric: 'Must state 9am and be polite.' });
  writeCached(key, {
    pass: false,
    score: 50,
    reasoning: 'half',
    criteria: [
      { criterion: 'states 9am', met: true },
      { criterion: 'is polite', met: false, why: 'blunt' },
    ],
  });
  assert.equal(readCached(key)?.criteria?.[1].why, 'blunt');
});

test('JUDGE_CACHE=off neither reads nor writes', () => {
  const key = cacheKey('local/qwen3.5:9b', INPUT);
  process.env.JUDGE_CACHE = 'off';
  writeCached(key, { pass: true, score: 91, reasoning: 'states 9am' });
  assert.equal(readCached(key), undefined);

  delete process.env.JUDGE_CACHE;
  assert.equal(readCached(key), undefined, 'nothing should have been written while off');
});

test('a corrupt cache file reads as a miss, not a crash', () => {
  const key = cacheKey('local/qwen3.5:9b', INPUT);
  const dir = path.join(temp, '.judge', 'cache');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${key}.json`), '{ half-written');
  assert.equal(readCached(key), undefined);
});
