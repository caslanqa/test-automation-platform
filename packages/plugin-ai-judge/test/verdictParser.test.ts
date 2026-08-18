/** The shapes real judge models return around the verdict JSON, and the ones that must still fail. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VerdictParseError, parseVerdict } from '../src/ai/judge/verdictParser.js';

test('a clean verdict parses unchanged', () => {
  const verdict = parseVerdict('{"reasoning":"states 9am","score":92,"pass":true}');
  assert.deepEqual(verdict, { pass: true, score: 92, reasoning: 'states 9am' });
});

test('a thinking block, a fence and surrounding prose are stripped', () => {
  const verdict = parseVerdict(
    'Sure!\n<think>the rubric asks for 9am…</think>\n```json\n{"reasoning":"ok","score":80,"pass":true}\n```\nHope this helps!',
  );
  assert.equal(verdict.score, 80);
  assert.equal(verdict.pass, true);
});

test('an unterminated thinking block does not swallow the verdict', () => {
  const verdict = parseVerdict('<think>reasoning that never closes {"score": 1}');
  assert.equal(verdict.score, 1);
});

test('a brace inside a string does not end the object', () => {
  const verdict = parseVerdict('{"reasoning":"said \\"{oops}\\" and }","score":50,"pass":false}');
  assert.equal(verdict.reasoning, 'said "{oops}" and }');
  assert.equal(verdict.pass, false);
});

test('a string pass and a string score are coerced', () => {
  const verdict = parseVerdict('{"reasoning":"fine","score":"88","pass":"yes"}');
  assert.deepEqual(verdict, { pass: true, score: 88, reasoning: 'fine' });
});

test('a score outside 0-100 is clamped and a float is rounded', () => {
  assert.equal(parseVerdict('{"score":140,"pass":true,"reasoning":""}').score, 100);
  assert.equal(parseVerdict('{"score":-5,"pass":false,"reasoning":""}').score, 0);
  assert.equal(parseVerdict('{"score":79.6,"pass":true,"reasoning":""}').score, 80);
});

test('alternative field names are read', () => {
  const verdict = parseVerdict('{"reason":"close enough","rating":70,"verdict":"PASS"}');
  assert.deepEqual(verdict, { pass: true, score: 70, reasoning: 'close enough' });
});

test('a missing pass falls back to the score midpoint', () => {
  assert.equal(parseVerdict('{"score":60,"reasoning":""}').pass, true);
  assert.equal(parseVerdict('{"score":40,"reasoning":""}').pass, false);
});

test('a reply with no JSON object throws VerdictParseError', () => {
  assert.throws(() => parseVerdict('The response looks good to me.'), VerdictParseError);
  assert.throws(() => parseVerdict('{"score": broken'), VerdictParseError);
});
