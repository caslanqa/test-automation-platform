/** The agreement maths and the dataset reader — the parts that must be right before any model is judged. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { kappa, toExpected } from '../src/calibrate/calibrate.js';
import { loadDataset, loadProjectEnv } from '../src/calibrate/dataset.js';

const pair = (expected: boolean, actual: boolean) => ({ expected, actual });

test('perfect agreement on a mixed set is kappa 1', () => {
  assert.equal(kappa([pair(true, true), pair(false, false), pair(true, true)]), 1);
});

test('a judge that passes everything scores 0 against a mixed set', () => {
  assert.equal(kappa([pair(true, true), pair(false, true)]), 0);
});

test('both raters unanimous and agreeing is 1, disagreeing is 0', () => {
  assert.equal(kappa([pair(true, true), pair(true, true)]), 1);
  assert.equal(kappa([pair(true, false), pair(true, false)]), 0);
});

test('a judge that inverts every human label is kappa -1', () => {
  assert.equal(
    kappa([pair(true, false), pair(true, false), pair(false, true), pair(false, true)]),
    -1,
  );
});

test('half right on a balanced set is chance, so kappa is 0', () => {
  assert.equal(
    kappa([pair(true, false), pair(false, true), pair(true, true), pair(false, false)]),
    0,
  );
});

test('an empty set is 0, not NaN', () => {
  assert.equal(kappa([]), 0);
});

test("a human label reads as a boolean or as 'pass'/'fail'", () => {
  assert.deepEqual([toExpected(true), toExpected('pass'), toExpected('fail')], [true, true, false]);
});

test('a dataset loads from either shape and resolves its images', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-dataset-'));
  const wrapped = path.join(dir, 'wrapped.json');
  fs.writeFileSync(
    wrapped,
    JSON.stringify({
      cases: [{ name: 'a', expected: 'pass', input: { rubric: 'r', image: 'shots/one.png' } }],
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'bare.json'),
    JSON.stringify([{ expected: false, input: { rubric: 'r' } }]),
  );

  assert.equal(loadDataset(wrapped)[0].input.image, path.join(dir, 'shots', 'one.png'));
  assert.equal(loadDataset(path.join(dir, 'bare.json')).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a dataset that is empty, unreadable or missing a label says which', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-dataset-'));
  fs.writeFileSync(path.join(dir, 'empty.json'), '{"cases":[]}');
  fs.writeFileSync(path.join(dir, 'unlabelled.json'), '{"cases":[{"input":{"rubric":"r"}}]}');

  assert.throws(() => loadDataset(path.join(dir, 'empty.json')), /holds no cases/);
  assert.throws(
    () => loadDataset(path.join(dir, 'unlabelled.json')),
    /needs both 'input' and 'expected'/,
  );
  assert.throws(() => loadDataset(path.join(dir, 'nope.json')), /could not read/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('project env fills only the keys the caller left unset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-env-'));
  fs.mkdirSync(path.join(dir, 'env'));
  fs.writeFileSync(
    path.join(dir, 'env', 'environments.json'),
    JSON.stringify({
      common: { DEFAULT_TEST_ENV: 'dev', JUDGE_MODEL: 'local/from-file', JUDGE_CACHE: '' },
      environments: { dev: { BASE_URL: 'https://dev.example.com' } },
    }),
  );

  process.env.JUDGE_MODEL = 'local/from-shell';
  delete process.env.BASE_URL;
  loadProjectEnv(dir);

  assert.equal(process.env.JUDGE_MODEL, 'local/from-shell', 'the shell must win');
  assert.equal(process.env.BASE_URL, 'https://dev.example.com');
  assert.equal(process.env.JUDGE_CACHE, undefined, 'an empty value is not a setting');

  delete process.env.JUDGE_MODEL;
  delete process.env.BASE_URL;
  fs.rmSync(dir, { recursive: true, force: true });
});
