/**
 * Which failures become defects.
 *
 * The whitelist is the whole safety property, so most of this file is about what does NOT get filed.
 * A flaky test opening a defect fills the tracker with noise, and a tracker nobody reads hides the
 * real defect too — that is a worse outcome than filing nothing at all.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { defectBody, defectTitle, planDefects } from '../src/defects/plan.js';
import { readQuarantine, readTriage, type TriageFinding } from '../src/heal/read.js';
import { healTitle, sameFile } from '../src/sync/discover.js';

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fileWith(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-heal-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

const finding = (over: Partial<TriageFinding> = {}): TriageFinding => ({
  testKey: 'abc123',
  project: 'chromium',
  file: 'tests/checkout/cart.spec.ts',
  line: 12,
  title: 'cart › rejects an expired card',
  outcome: 'unexpected',
  class: 'true-fail',
  confidence: 88,
  band: 'act',
  reasons: ['a value mismatch is never a locator problem'],
  ...over,
});

const RUN = { runId: 'run-1', commit: 'a1b2c3d', startedAt: '2026-08-26T00:00:00.000Z' };

test('a true-fail opens a defect', () => {
  const plan = planDefects([finding()], [], RUN);

  assert.equal(plan.open.length, 1);
  assert.equal(plan.open[0].title, 'cart › rejects an expired card — tests/checkout/cart.spec.ts');
});

test('every other class is skipped, with the reason stated', () => {
  const plan = planDefects(
    [
      finding({ class: 'flaky' }),
      finding({ class: 'locator-drift' }),
      finding({ class: 'env-infra' }),
      finding({ class: 'unknown' }),
    ],
    [],
    RUN,
  );

  assert.equal(plan.open.length, 0, 'nothing but true-fail may ever be filed');
  assert.equal(plan.skipped.length, 4);
  assert.match(plan.skipped[0].reason, /noise/);
  assert.match(plan.skipped[1].reason, /needs repairing, not the product/);
  assert.match(plan.skipped[2].reason, /environment failed/);
  assert.match(plan.skipped[3].reason, /could not classify/);
});

test('a low-confidence true-fail is still filed — heal owns the threshold, not this', () => {
  const plan = planDefects([finding({ confidence: 42, band: 'ask' })], [], RUN);

  assert.equal(plan.open.length, 1, 're-thresholding here would be a second, invisible policy');
});

test('an open defect with the same title is not opened twice', () => {
  const title = defectTitle(finding());
  const plan = planDefects([finding()], [{ id: '7', title }], RUN);

  assert.equal(plan.open.length, 0);
  assert.deepEqual(
    plan.existing.map(entry => entry.defectId),
    ['7'],
  );
});

test('one test failing on two projects opens one defect, not two', () => {
  const plan = planDefects(
    [finding({ project: 'chromium' }), finding({ project: 'webkit' })],
    [],
    RUN,
  );

  assert.equal(plan.open.length, 1);
  assert.equal(plan.existing.length, 1);
});

test('the same test title in two files is two defects', () => {
  const plan = planDefects([finding(), finding({ file: 'tests/admin/cart.spec.ts' })], [], RUN);

  assert.equal(plan.open.length, 2, 'the file is part of the identity for exactly this reason');
});

test('the body carries the run, the classification and heal’s reasons — nothing inferred', () => {
  const body = defectBody(finding(), RUN);

  assert.match(body, /tests\/checkout\/cart\.spec\.ts:12/);
  assert.match(body, /true-fail \(88% — act\)/);
  assert.match(body, /run-1 at a1b2c3d/);
  assert.match(body, /a value mismatch is never a locator problem/);
  assert.match(body, /flaky, locator-drift and env-infra never do/);
});

// --- reading heal's files ------------------------------------------------------------------------

test('a missing triage report is undefined, not an error — heal is optional', () => {
  assert.equal(readTriage('/nowhere/triage.json'), undefined);
});

test('a file that is not a triage report says what to run', () => {
  const file = fileWith('triage.json', JSON.stringify({ hello: 'world' }));

  assert.throws(() => readTriage(file), /does not look like a heal triage report/);
});

test('malformed findings are dropped, the rest survive', () => {
  const file = fileWith(
    'triage.json',
    JSON.stringify({
      runId: 'r1',
      findings: [{ nope: true }, { testKey: 'a', title: 't', class: 'true-fail' }],
    }),
  );

  const report = readTriage(file);
  assert.equal(report?.findings.length, 1);
  assert.equal(report?.runId, 'r1');
});

test('the quarantine list reads, and a missing one is empty', () => {
  const file = fileWith(
    'quarantine.json',
    JSON.stringify({
      version: 1,
      entries: [
        {
          testKey: 'a',
          project: 'chromium',
          file: 'tests/a.spec.ts',
          title: 'a › b',
          class: 'flaky',
          reason: 'x',
        },
        { broken: true },
      ],
    }),
  );

  assert.equal(readQuarantine(file).length, 1);
  assert.deepEqual(readQuarantine('/nowhere/quarantine.json'), []);
});

// --- joining heal's identity to ours --------------------------------------------------------------

test('healTitle drops the directory and file stem that only WE prepend', () => {
  assert.equal(
    healTitle({
      file: 'checkout/cart.spec.ts',
      suitePath: ['checkout', 'cart', 'totals'],
      title: 'adds tax',
    }),
    'totals › adds tax',
  );
  assert.equal(
    healTitle({ file: 'smoke.spec.ts', suitePath: ['smoke'], title: 'it works' }),
    'it works',
  );
});

test('the two file bases are bridged by suffix, in either direction', () => {
  // heal's path is relative to the project; ours to Playwright's rootDir, which is the tests dir.
  assert.equal(sameFile('tests/checkout/cart.spec.ts', 'checkout/cart.spec.ts'), true);
  assert.equal(sameFile('checkout/cart.spec.ts', 'checkout/cart.spec.ts'), true);
  assert.equal(sameFile('tests/admin/cart.spec.ts', 'checkout/cart.spec.ts'), false);
  assert.equal(
    sameFile('tests/cart.spec.ts', 'other-cart.spec.ts'),
    false,
    'a suffix match must not straddle a path segment',
  );
});
