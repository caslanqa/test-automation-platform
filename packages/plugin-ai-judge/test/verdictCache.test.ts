/** Cache keys must ignore the per-call nonce but split on anything that changes the judgement. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { cacheKey, readCached, writeCached } from '../src/ai/judge/verdictCache.js';
import type { JudgeInput } from '../src/ai/types.js';

const MODEL = { id: 'local/qwen3.5:9b', revision: 'abc123def456' };

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
  assert.equal(cacheKey(MODEL, INPUT), cacheKey(MODEL, { ...INPUT }));
});

test('a different model, response, rubric or mode yields a different key', () => {
  const base = cacheKey(MODEL, INPUT);
  assert.notEqual(base, cacheKey({ id: 'local/qwen3.5:4b' }, INPUT));
  assert.notEqual(base, cacheKey(MODEL, { ...INPUT, botResponse: 'We open at 10am.' }));
  assert.notEqual(base, cacheKey(MODEL, { ...INPUT, rubric: 'Must state 10am.' }));
  assert.notEqual(
    cacheKey({ id: 'm' }, { image: Buffer.from('a'), rubric: 'r' }),
    cacheKey(
      { id: 'm' },
      { image: Buffer.from('a'), referenceImage: Buffer.from('a'), rubric: 'r' },
    ),
  );
});

test('a re-pulled model build invalidates its verdicts', () => {
  const repulled = { id: MODEL.id, revision: 'ffff99998888' };
  assert.notEqual(cacheKey(MODEL, INPUT), cacheKey(repulled, INPUT));
  assert.notEqual(cacheKey(MODEL, INPUT), cacheKey({ id: MODEL.id }, INPUT));
});

test('repeat samples of one input get their own keys, and sample 0 keeps the old key', () => {
  const base = cacheKey(MODEL, INPUT);
  assert.equal(cacheKey(MODEL, INPUT, 0), base);
  assert.notEqual(cacheKey(MODEL, INPUT, 1), base);
  assert.notEqual(cacheKey(MODEL, INPUT, 2), cacheKey(MODEL, INPUT, 1));
});

test('context, a reference answer and a conversation all take part in the key', () => {
  const base = cacheKey({ id: 'm' }, INPUT);
  assert.notEqual(base, cacheKey({ id: 'm' }, { ...INPUT, context: 'Opening hours: 9am.' }));
  assert.notEqual(base, cacheKey({ id: 'm' }, { ...INPUT, referenceAnswer: 'We open at 9am.' }));
  assert.notEqual(
    base,
    cacheKey({ id: 'm' }, { ...INPUT, conversation: [{ role: 'user', content: 'hi' }] }),
  );
  assert.notEqual(
    cacheKey({ id: 'm' }, { ...INPUT, context: 'a' }),
    cacheKey({ id: 'm' }, { ...INPUT, context: 'b' }),
  );
});

test('images take part in the key', () => {
  assert.notEqual(
    cacheKey({ id: 'm' }, { rubric: 'r', image: Buffer.from('one') }),
    cacheKey({ id: 'm' }, { rubric: 'r', image: Buffer.from('two') }),
  );
});

test('a written verdict is replayed without its routing trace', () => {
  const key = cacheKey(MODEL, INPUT);
  assert.equal(readCached(key), undefined);

  writeCached(
    key,
    {
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
    },
    INPUT,
  );
  assert.deepEqual(readCached(key), { pass: true, score: 91, reasoning: 'states 9am' });
});

test('the checklist survives a round trip', () => {
  const key = cacheKey(MODEL, { ...INPUT, rubric: 'Must state 9am and be polite.' });
  writeCached(
    key,
    {
      pass: false,
      score: 50,
      reasoning: 'half',
      criteria: [
        { criterion: 'states 9am', met: true },
        { criterion: 'is polite', met: false, why: 'blunt' },
      ],
    },
    INPUT,
  );
  assert.equal(readCached(key)?.criteria?.[1].why, 'blunt');
});

test('JUDGE_CACHE=off neither reads nor writes', () => {
  const key = cacheKey(MODEL, INPUT);
  process.env.JUDGE_CACHE = 'off';
  writeCached(key, { pass: true, score: 91, reasoning: 'states 9am' }, INPUT);
  assert.equal(readCached(key), undefined);

  delete process.env.JUDGE_CACHE;
  assert.equal(readCached(key), undefined, 'nothing should have been written while off');
});

test('the material is stored with the verdict, images excluded', () => {
  const key = cacheKey(MODEL, INPUT);
  writeCached(
    key,
    { pass: true, score: 91, reasoning: 'ok' },
    { ...INPUT, image: Buffer.from('x') },
  );

  const stored = JSON.parse(
    fs.readFileSync(path.join(temp, '.judge', 'cache', `${key}.json`), 'utf8'),
  ) as { input?: Record<string, unknown> };
  assert.equal(stored.input?.botResponse, INPUT.botResponse);
  assert.equal(stored.input?.hasImage, true);
  assert.equal('image' in (stored.input ?? {}), false, 'a buffer per entry would bloat the cache');
});

test('a corrupt cache file reads as a miss, not a crash', () => {
  const key = cacheKey(MODEL, INPUT);
  const dir = path.join(temp, '.judge', 'cache');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${key}.json`), '{ half-written');
  assert.equal(readCached(key), undefined);
});
