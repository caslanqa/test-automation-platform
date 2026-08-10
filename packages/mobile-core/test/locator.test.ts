/**
 * Locator engine tests. These encode the normative claims in docs/mobile-inspector/architecture.md §7 —
 * the hit-test policy and the candidate ranking — precisely because those are the rules most likely to be
 * "simplified" away by a later refactor. Every expected score below is the one the spec states, so a
 * change in ranking has to be an explicit decision, not an accident.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  centerOf,
  countMatches,
  findNode,
  hitTest,
  locatorCandidates,
  locatorForNode,
  outOfAppWarning,
  resolveTargetPoint,
} from '../src/locator.js';
import type { MobileNode } from '../src/types.js';

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

test('hitTest prefers the smallest node that has a stable locator over the smallest node overall', () => {
  // A real native tree shape: an actionable button wrapping an anonymous implementation child.
  const button: MobileNode = {
    bounds: box(0, 0, 100, 50),
    accessibilityId: 'loginButton',
    children: [{ bounds: box(10, 10, 20, 20) }], // no id/text — an anonymous inner view
  };

  const hit = hitTest([button], 15, 15);

  assert.equal(
    hit?.accessibilityId,
    'loginButton',
    'must not reduce an identified control to its anonymous child',
  );
});

test('hitTest falls back to the smallest node when nothing containing the point is identifiable', () => {
  const anonymousParent: MobileNode = {
    bounds: box(0, 0, 100, 50),
    children: [{ bounds: box(10, 10, 20, 20), className: 'inner' }],
  };

  assert.equal(hitTest([anonymousParent], 15, 15)?.className, 'inner');
});

test('hitTest returns undefined when the point is outside every node', () => {
  assert.equal(hitTest([{ bounds: box(0, 0, 10, 10) }], 500, 500), undefined);
});

test('locatorForNode ranks accessibilityId over resourceId over text', () => {
  assert.deepEqual(locatorForNode({ accessibilityId: 'a', resourceId: 'r', text: 't' }), {
    accessibilityId: 'a',
    label: 'a',
  });
  assert.deepEqual(locatorForNode({ resourceId: 'r', text: 't' }), { resourceId: 'r', label: 'r' });
  assert.deepEqual(locatorForNode({ text: 't' }), { text: 't', label: 't' });
});

test('locatorForNode falls back to a coordinate and flags it as fragile', () => {
  const locator = locatorForNode({ bounds: box(10, 20, 30, 40) });

  assert.deepEqual(locator.point, { x: 25, y: 40 });
  assert.match(locator.label ?? '', /fragile/, 'a coordinate locator must announce its fragility');
});

test('locatorCandidates ranks every strategy best-first with the scores the spec fixes', () => {
  const node: MobileNode = {
    bounds: box(0, 0, 100, 50),
    accessibilityId: 'loginButton',
    resourceId: 'com.example:id/login',
    text: 'Log in',
  };

  const candidates = locatorCandidates(node, [node]);

  assert.deepEqual(
    candidates.map(c => [c.strategy, c.score, c.confidence]),
    [
      ['accessibilityId', 92, 'high'],
      ['resourceId', 80, 'high'],
      ['text', 58, 'medium'],
      ['point', 12, 'low'],
    ],
  );
  assert.equal(candidates.at(-1)?.strategy, 'point', 'coordinates must always rank last');
  assert.ok(candidates.at(-1)?.warnings.length, 'the coordinate candidate must carry a warning');
  assert.equal(candidates.at(-1)?.unique, false, 'coordinates are never "unique"');
});

test('locatorCandidates penalises a non-unique locator and says why', () => {
  const twin: MobileNode = { bounds: box(0, 0, 10, 10), text: 'Delete' };
  const hierarchy: MobileNode[] = [twin, { bounds: box(0, 20, 10, 10), text: 'Delete' }];

  const [text] = locatorCandidates(twin, hierarchy).filter(
    c => c.strategy === 'text' && c.locator.index === undefined,
  );

  assert.equal(text.score, 58 - 25);
  assert.equal(text.unique, false);
  assert.match(text.warnings.join(' '), /not unique/);
});

test('a non-unique locator also gets an ordinal candidate, which is what a list row needs', () => {
  // Every attribute of a repeated row is non-unique, and the only candidate that used to survive that was a
  // raw coordinate — so recording "the second Delete" produced a step that broke on any layout change.
  const second: MobileNode = { bounds: box(0, 20, 10, 10), text: 'Delete' };
  const hierarchy: MobileNode[] = [{ bounds: box(0, 0, 10, 10), text: 'Delete' }, second];

  const candidates = locatorCandidates(second, hierarchy);
  const indexed = candidates.find(c => c.locator.index !== undefined);

  assert.ok(indexed, 'a non-unique attribute must still offer a way to address one element');
  assert.deepEqual(
    indexed.locator,
    { text: 'Delete', index: 1 },
    'the ordinal of the node clicked',
  );
  assert.equal(indexed.unique, true, 'it selects one element by construction');
  assert.equal(
    indexed.score,
    58 - 10,
    'ranked below a genuinely unique locator, above a coordinate',
  );
  assert.match(indexed.warnings.join(' '), /position-dependent/);
  assert.equal(indexed.display, '{ text: "Delete", index: 1 }');
  // And it outranks the coordinate fallback it exists to replace.
  assert.ok(
    candidates.indexOf(indexed) < candidates.findIndex(c => c.strategy === 'point'),
    'an ordinal locator must be offered before a coordinate',
  );
});

test('a unique locator gets no ordinal candidate, because there is nothing to disambiguate', () => {
  const node: MobileNode = { bounds: box(0, 0, 10, 10), text: 'Delete' };

  const candidates = locatorCandidates(node, [node]);

  assert.equal(candidates.filter(c => c.locator.index !== undefined).length, 0);
});

test('locatorCandidates warns that long text is likely dynamic or localized', () => {
  const node: MobileNode = { text: 'x'.repeat(41), bounds: box(0, 0, 10, 10) };

  const [text] = locatorCandidates(node, [node]).filter(c => c.strategy === 'text');

  assert.match(text.warnings.join(' '), /dynamic\/localized/);
});

test('locatorCandidates emits nothing but a coordinate for an unidentifiable node', () => {
  const node: MobileNode = { bounds: box(0, 0, 10, 10) };

  assert.deepEqual(
    locatorCandidates(node, [node]).map(c => c.strategy),
    ['point'],
  );
});

test('countMatches counts matches at every depth', () => {
  const hierarchy: MobileNode[] = [
    { text: 'Save' },
    { children: [{ text: 'Save' }, { children: [{ text: 'Save' }] }] },
  ];

  assert.equal(countMatches(hierarchy, { text: 'Save' }), 3);
  assert.equal(countMatches(hierarchy, { text: 'Cancel' }), 0);
});

test('findNode requires every field set on the locator to match', () => {
  const hierarchy: MobileNode[] = [
    { text: 'Save', resourceId: 'other' },
    { text: 'Save', resourceId: 'wanted' },
  ];

  assert.equal(findNode(hierarchy, { text: 'Save', resourceId: 'wanted' })?.resourceId, 'wanted');
  assert.equal(findNode(hierarchy, { text: 'Save', resourceId: 'missing' }), undefined);
});

test('centerOf rounds to whole device pixels, and is undefined without bounds', () => {
  assert.deepEqual(centerOf({ bounds: box(0, 0, 101, 51) }), { x: 51, y: 26 });
  assert.equal(centerOf({}), undefined);
});

test('resolveTargetPoint passes explicit coordinates through and resolves locators to a center', () => {
  const hierarchy: MobileNode[] = [{ accessibilityId: 'ok', bounds: box(10, 10, 20, 20) }];

  assert.deepEqual(resolveTargetPoint({ x: 7, y: 9 }, hierarchy), { x: 7, y: 9 });
  assert.deepEqual(resolveTargetPoint({ accessibilityId: 'ok' }, hierarchy), { x: 20, y: 20 });
});

test('resolveTargetPoint fails loudly rather than guessing a point', () => {
  assert.throws(() => resolveTargetPoint({ accessibilityId: 'nope' }, []), /no element matched/);
  assert.throws(
    () => resolveTargetPoint({ accessibilityId: 'ok' }, [{ accessibilityId: 'ok' }]),
    /no bounds/,
  );
});

test('a node from another app is penalised and says why', () => {
  const statusBar: MobileNode = {
    bounds: box(0, 0, 400, 40),
    accessibilityId: 'Battery 100 percent.',
    appPackage: 'com.android.systemui',
  };

  const [best] = locatorCandidates(statusBar, [statusBar], { appId: 'com.example.app' });

  assert.equal(
    best.score,
    92 - 60,
    'it cannot resolve on replay, so it must not read as high confidence',
  );
  assert.equal(best.confidence, 'low');
  assert.match(best.warnings.join(' '), /com\.android\.systemui/);
  assert.match(best.warnings.join(' '), /not resolve on replay/);
});

test('a node from the app under test is not penalised', () => {
  const inApp: MobileNode = {
    bounds: box(0, 0, 100, 40),
    accessibilityId: 'login',
    appPackage: 'com.example.app',
  };

  assert.equal(locatorCandidates(inApp, [inApp], { appId: 'com.example.app' })[0].score, 92);
});

test('with no package or no app id there is nothing to compare, so no penalty', () => {
  const unknown: MobileNode = { bounds: box(0, 0, 100, 40), accessibilityId: 'login' };

  assert.equal(locatorCandidates(unknown, [unknown], { appId: 'com.example.app' })[0].score, 92);
  assert.equal(outOfAppWarning({ appPackage: 'com.other' }, undefined), undefined);
});
