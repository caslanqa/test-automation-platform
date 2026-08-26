/**
 * The plan. Pure, so every branch is reachable without a network — which is the point: `--dry-run` is
 * the default and has to be the same computation `--apply` runs, not a second description of it.
 *
 * The assertions that matter most are the ones about what a sync *refuses* to conclude: a dangling id
 * is not a licence to create a second case, and a case missing from the code is not a licence to delete.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TmsCase } from '../src/provider.js';
import { planIsEmpty, planSync } from '../src/sync/diff.js';
import type { DiscoveredTest } from '../src/sync/discover.js';

const aTest = (over: Partial<DiscoveredTest> = {}): DiscoveredTest => ({
  file: 'cart.spec.ts',
  suitePath: ['cart'],
  title: 'rejects an expired card',
  line: 3,
  column: 5,
  tags: [],
  caseIds: [],
  requirements: [],
  projects: ['chromium'],
  ...over,
});

const aCase = (over: Partial<TmsCase> = {}): TmsCase => ({
  id: '42',
  title: 'rejects an expired card',
  suitePath: ['cart'],
  tags: [],
  requirements: [],
  automated: true,
  ...over,
});

test('an unknown test becomes a create, with a ref that identifies its call site', () => {
  const plan = planSync([aTest()], []);

  assert.equal(plan.create.length, 1);
  assert.equal(plan.create[0].case.title, 'rejects an expired card');
  assert.deepEqual(plan.create[0].case.suitePath, ['cart']);
  assert.match(plan.create[0].case.ref, /cart\.spec\.ts:3:5/);
});

test('an id in the annotation outranks everything, so a renamed and moved test keeps its case', () => {
  const plan = planSync(
    [
      aTest({
        caseIds: [42],
        title: 'rejects a card that expired',
        suitePath: ['checkout', 'cart'],
      }),
    ],
    [aCase()],
  );

  assert.equal(plan.create.length, 0);
  assert.equal(plan.adopt.length, 0);
  assert.equal(plan.update.length, 1);
  assert.deepEqual(plan.update[0].changed, ['title', 'suite']);
  assert.equal(plan.update[0].caseId, '42');
});

test('a test with no id matching an existing case by suite and title is adopted, not duplicated', () => {
  const plan = planSync([aTest()], [aCase()]);

  assert.equal(plan.create.length, 0);
  assert.deepEqual(plan.adopt, [{ test: plan.adopt[0].test, caseId: '42', wasManual: false }]);
  assert.equal(plan.orphans.length, 0, 'an adopted case is accounted for');
});

test('adopting a manual case says so — automating it is the point, but not silently', () => {
  const plan = planSync([aTest()], [aCase({ automated: false })]);

  assert.equal(plan.adopt[0].wasManual, true);
});

test('a manual case with no test is not an orphan — this sync does not own manual cases', () => {
  const plan = planSync([], [aCase({ automated: false })]);

  assert.deepEqual(plan.orphans, []);
});

test('an automated case with no test is an orphan, reported and left alone', () => {
  const plan = planSync([], [aCase()]);

  assert.equal(plan.orphans.length, 1);
  assert.equal(plan.orphans[0].id, '42');
  assert.equal(plan.create.length, 0);
});

test('an id naming a case that is gone is dangling — never quietly recreated', () => {
  const plan = planSync([aTest({ caseIds: [999] })], [aCase()]);

  assert.equal(plan.create.length, 0, 'recreating would start a second history for the same test');
  assert.deepEqual(
    plan.dangling.map(entry => entry.caseId),
    ['999'],
  );
});

test('identical means unchanged, and an unchanged plan is empty', () => {
  const plan = planSync([aTest({ caseIds: [42] })], [aCase()]);

  assert.equal(plan.unchanged, 1);
  assert.equal(plan.update.length, 0);
  assert.equal(planIsEmpty(plan), true);
});

test('tags drift regardless of order — a reordered tag list is not a change', () => {
  const same = planSync(
    [aTest({ caseIds: [42], tags: ['b', 'a'] })],
    [aCase({ tags: ['a', 'b'] })],
  );
  assert.equal(same.unchanged, 1);

  const drifted = planSync(
    [aTest({ caseIds: [42], tags: ['a', 'c'] })],
    [aCase({ tags: ['a', 'b'] })],
  );
  assert.deepEqual(drifted.update[0].changed, ['tags']);
  assert.deepEqual(drifted.update[0].patch.tags, ['a', 'c']);
});

test('two tests cannot adopt the same case', () => {
  const plan = planSync([aTest(), aTest({ line: 9 })], [aCase()]);

  assert.equal(plan.adopt.length, 1);
  assert.equal(plan.create.length, 1, 'the second one needs a case of its own');
});

test('a duplicate in the tool resolves the same way every run', () => {
  const first = planSync([aTest()], [aCase({ id: '1' }), aCase({ id: '2' })]);
  const second = planSync([aTest()], [aCase({ id: '1' }), aCase({ id: '2' })]);

  assert.equal(first.adopt[0].caseId, '1');
  assert.equal(second.adopt[0].caseId, '1');
  assert.equal(
    first.orphans[0].id,
    '2',
    'the one nobody claimed is reported, not silently ignored',
  );
});

test('a parameterised test is planned like any other but flagged as unwritable', () => {
  const plan = planSync([aTest({ unwritableReason: 'several tests share this test() call' })], []);

  assert.equal(plan.create.length, 1);
  assert.equal(plan.unwritable.length, 1, 'no id can be written at a shared call site');
});
