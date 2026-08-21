/** Drafting calibration cases out of the cache: what gets skipped, what comes first, what is labelled. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { harvestCases, harvestToDataset } from '../src/calibrate/harvest.js';

let dir: string;

const write = (name: string, entry: unknown): void =>
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(entry));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-harvest-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing cache directory harvests nothing instead of throwing', () => {
  assert.deepEqual(harvestCases(path.join(dir, 'nope')).cases, []);
});

test('each case is labelled with what the judge said and why', () => {
  write('a', {
    pass: false,
    score: 67,
    reasoning: 'missed Sunday',
    criteria: [
      { criterion: 'states 9am', met: true },
      { criterion: 'mentions Sunday', met: false },
    ],
    input: { botResponse: 'We open at 9am.', rubric: 'States 9am and mentions Sunday.' },
  });

  const [harvested] = harvestCases(dir).cases;
  assert.equal(harvested.expected, 'fail');
  assert.equal(harvested.judgeSaid.score, 67);
  assert.deepEqual(harvested.judgeSaid.unmet, ['mentions Sunday']);
  assert.equal(harvested.name, 'We open at 9am.', 'named after what varies, not the shared rubric');
  assert.equal(harvested.input.rubric, 'States 9am and mentions Sunday.');
});

test('the least certain verdicts come first', () => {
  write('confident', { pass: true, score: 100, input: { rubric: 'A', botResponse: 'a' } });
  write('borderline', {
    pass: false,
    score: 60,
    criteria: [
      { criterion: 'x', met: true },
      { criterion: 'y', met: false },
    ],
    input: { rubric: 'B', botResponse: 'b' },
  });
  write('clear-fail', { pass: false, score: 0, input: { rubric: 'C', botResponse: 'c' } });

  const order = harvestCases(dir).cases.map(entry => entry.input.rubric);
  assert.equal(order[0], 'B', 'a partly-met checklist wants a human before a 0 or a 100 does');
  assert.deepEqual(order.slice(1).sort(), ['A', 'C']);
});

test('the order does not depend on the filesystem', () => {
  write('zzz', { pass: true, score: 100, input: { rubric: 'A', botResponse: 'a' } });
  write('aaa', { pass: false, score: 0, input: { rubric: 'C', botResponse: 'c' } });
  assert.deepEqual(
    harvestCases(dir).cases.map(entry => entry.input.rubric),
    harvestCases(dir).cases.map(entry => entry.input.rubric),
  );
});

test('entries without material, with an image, or judged twice are skipped', () => {
  write('legacy', { pass: true, score: 90 });
  write('with-image', { pass: true, score: 90, input: { rubric: 'A', hasImage: true } });
  write('sample-0', { pass: true, score: 90, input: { rubric: 'B', botResponse: 'b' } });
  write('sample-1', { pass: false, score: 40, input: { rubric: 'B', botResponse: 'b' } });
  write('corrupt', 'not json at all');
  fs.writeFileSync(path.join(dir, 'corrupt.json'), '{ half');

  const { cases, skipped } = harvestCases(dir);
  assert.equal(cases.length, 1);
  assert.equal(skipped.withImage, 1);
  assert.equal(skipped.duplicates, 1);
  assert.equal(skipped.withoutMaterial, 2, 'the legacy entry and the corrupt file');
  assert.equal('hasImage' in cases[0].input, false);
});

test('the written dataset is loadable and says the labels are the judge’s own', () => {
  write('a', { pass: true, score: 100, input: { rubric: 'A', botResponse: 'a' } });
  const text = harvestToDataset(harvestCases(dir));
  const parsed = JSON.parse(text) as { _note: string; cases: unknown[] };
  assert.match(parsed._note, /what the JUDGE said, not what a human said/);
  assert.equal(parsed.cases.length, 1);
});
