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

test('the score comes from the checklist, not from the model', () => {
  const verdict = parseVerdict(
    JSON.stringify({
      criteria: [
        { criterion: 'states 9am', met: false, why: 'said 6pm' },
        { criterion: 'states 6pm', met: true },
        { criterion: 'is polite', met: true },
      ],
      reasoning: 'wrong opening hour',
      score: 90,
      pass: true,
    }),
  );
  assert.equal(verdict.score, 67, "the model's own 90 must lose to 2 of 3 criteria");
  assert.equal(verdict.pass, false, 'an unmet requirement cannot pass');
  assert.equal(verdict.criteria?.length, 3);
  assert.equal(verdict.criteria?.[0].why, 'said 6pm');
});

test('a weight the model volunteers is dropped, so the score stays comparable', () => {
  const verdict = parseVerdict(
    '{"criteria":[{"criterion":"a","met":true,"weight":3},{"criterion":"b","met":false,"weight":1}],"reasoning":"","score":0,"pass":true}',
  );
  assert.equal(verdict.score, 50);
  assert.equal('weight' in (verdict.criteria?.[0] ?? {}), false);
});

test('a checklist with every criterion met keeps the pass', () => {
  const verdict = parseVerdict(
    '{"criteria":[{"criterion":"a","met":true},{"criterion":"b","met":"yes"}],"reasoning":"","score":10,"pass":true}',
  );
  assert.deepEqual([verdict.pass, verdict.score], [true, 100]);
});

test('an empty checklist leaves the score to the model', () => {
  const verdict = parseVerdict('{"criteria":[],"reasoning":"","score":73,"pass":true}');
  assert.deepEqual([verdict.pass, verdict.score, verdict.criteria], [true, 73, undefined]);
});

test('checklist entries without a requirement are dropped', () => {
  const verdict = parseVerdict(
    '{"criteria":[{"met":true},{"criterion":"","met":true},{"criterion":"a","met":false}],"score":50,"pass":true,"reasoning":""}',
  );
  assert.equal(verdict.criteria?.length, 1);
  assert.deepEqual([verdict.pass, verdict.score], [false, 0]);
});

test('a reply with no JSON object throws VerdictParseError', () => {
  assert.throws(() => parseVerdict('The response looks good to me.'), VerdictParseError);
  assert.throws(() => parseVerdict('{"score": broken'), VerdictParseError);
});
