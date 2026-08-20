/**
 * Mobile repair, with no device anywhere.
 *
 * That it is testable at all is the point of step 8. The plan called for a post-run probe against a
 * booted device — which cannot run in CI, so none of this could have been asserted. Capturing the
 * hierarchy into an attachment at the moment of failure turns mobile repair into the same shape as web
 * repair: read a file the run left behind. Everything below runs against a hand-written tree.
 *
 * The assertions that matter most are the refusals. A coordinate replacement passes today and taps empty
 * space after any layout change; a replacement outside the app under test cannot resolve on replay at
 * all; and a single identifier cannot distinguish an element from another one carrying it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseMobileIntent, readLiteral } from '../src/heal/mobile/intent.js';
import {
  analyseWithKit,
  flattenNodes,
  mobileTargets,
  proveMobile,
  renderLocator,
} from '../src/heal/mobile/target.js';
import type { MobileKit, MobileNodeLike } from '../src/heal/mobile/types.js';

// --- the literal parser ---------------------------------------------------------------------------

test('a plain locator literal is read out of the source line', () => {
  const intent = parseMobileIntent("    await mobileApp.tap({ accessibilityId: 'loginButton' });");
  assert.equal(intent?.locator.accessibilityId, 'loginButton');
  assert.deepEqual(intent?.signals, ['accessibilityId']);
  assert.equal(intent?.action, 'tap');
  assert.equal(intent?.code, "{ accessibilityId: 'loginButton' }");
});

test('several fields, mixed types, and double quotes all read', () => {
  const intent = parseMobileIntent('await mobileApp.fill({ text: "Log in", index: 2 }, value);');
  assert.equal(intent?.locator.text, 'Log in');
  assert.equal(intent?.locator.index, 2);
  assert.deepEqual(intent?.signals, ['text']);
});

test('a comma inside a label does not split the fields', () => {
  const intent = parseMobileIntent("await mobileApp.tap({ text: 'Yes, continue' });");
  assert.equal(intent?.locator.text, 'Yes, continue');
});

test('anything the parser cannot fully read refuses instead of guessing', () => {
  // Each of these hides part of the locator somewhere this line cannot see. A repair that rewrote the
  // half it could read would silently drop the half it could not.
  for (const line of [
    'await mobileApp.tap({ accessibilityId: id });', // a variable
    'await mobileApp.tap({ text: `Log ${verb}` });', // a template literal
    'await mobileApp.tap({ text });', // shorthand
    'await mobileApp.tap(LOGIN);', // no literal at all
    "await mobileApp.tap({ native: { xpath: '//*' } });", // the driver-specific escape hatch
  ]) {
    assert.equal(parseMobileIntent(line), undefined, line);
  }
});

test('a bare coordinate is recognised as identifying nothing', () => {
  const intent = parseMobileIntent('await mobileApp.tap({ x: 120, y: 340 });');
  assert.equal(intent?.coordinateOnly, true);
  assert.deepEqual(intent?.signals, []);
});

test('an unbalanced literal is not read as a truncated one', () => {
  assert.equal(readLiteral("{ accessibilityId: 'a'"), undefined);
});

// --- the tree -------------------------------------------------------------------------------------

/** A small screen: the login button lost its accessibility id, and kept its text. */
const screen: MobileNodeLike[] = [
  {
    key: '0',
    className: 'Root',
    children: [
      { key: '0/0', text: 'Welcome back', className: 'Text' },
      { key: '0/1', resourceId: 'com.example:id/submit', text: 'Log in', className: 'Button' },
      { key: '0/2', text: 'Log in', className: 'Link' },
      { key: '0/3', accessibilityId: 'statusClock', text: '09:41', className: 'StatusBar' },
    ],
  },
];

/**
 * A stand-in for `@pwtap/mobile-core`, so these tests do not require the mobile package to be installed
 * and do not re-test its ranking — which has its own suite. What is under test here is the glue and the
 * refusals, and a fake makes the inputs to those exact.
 */
const kit: MobileKit = {
  locatorCandidates: node => {
    const out = [];
    if (typeof node.accessibilityId === 'string') {
      out.push({
        strategy: 'accessibilityId' as const,
        locator: { accessibilityId: node.accessibilityId },
        score: 95,
        confidence: 'high' as const,
        unique: true,
        // The status-bar node is not in the app under test, and mobile-core says so.
        warnings:
          node.className === 'StatusBar'
            ? ['this element is outside the app under test and will not resolve on replay']
            : [],
      });
    }
    if (typeof node.resourceId === 'string') {
      out.push({
        strategy: 'resourceId' as const,
        locator: { resourceId: node.resourceId },
        score: 88,
        confidence: 'high' as const,
        unique: true,
        warnings: [],
      });
    }
    if (typeof node.text === 'string') {
      out.push({
        strategy: 'text' as const,
        locator: { text: node.text },
        score: 62,
        confidence: 'medium' as const,
        unique: false,
        warnings: ['not unique — multiple elements match this locator'],
      });
    }
    out.push({
      strategy: 'point' as const,
      locator: { x: 10, y: 20 },
      score: 12,
      confidence: 'low' as const,
      unique: false,
      warnings: ['fragile — a coordinate breaks on any layout change'],
    });
    return out;
  },
  findNodeByKey: (nodes, key) => flattenNodes(nodes).find(node => node.key === key),
  countMatches: (nodes, locator) =>
    flattenNodes(nodes).filter(
      node =>
        (locator.accessibilityId !== undefined &&
          node.accessibilityId === locator.accessibilityId) ||
        (locator.resourceId !== undefined && node.resourceId === locator.resourceId) ||
        (locator.text !== undefined && node.text === locator.text),
    ).length,
};

const intentFor = (line: string) => {
  const intent = parseMobileIntent(line);
  assert.ok(intent !== undefined, line);
  return intent;
};

test('a locator that still matches something finds its element', () => {
  const targets = mobileTargets(screen, intentFor("mobileApp.tap({ text: 'Log in' })"));
  assert.equal(targets.length, 2, 'both the button and the link carry that text');
});

test('a locator that matches nothing is refused, not guessed at', () => {
  const analysis = analyseWithKit(
    kit,
    { nodes: screen },
    intentFor("mobileApp.tap({ accessibilityId: 'loginButton' })"),
  );
  assert.equal(analysis.candidates.length, 0);
  assert.match(analysis.problem ?? '', /^no-target:/);
});

test('a coordinate is never offered as a replacement', () => {
  const analysis = analyseWithKit(
    kit,
    { nodes: screen },
    intentFor("mobileApp.tap({ text: 'Log in' })"),
  );
  assert.ok(analysis.candidates.length > 0);
  assert.ok(
    !analysis.candidates.some(candidate => candidate.strategy === 'point'),
    'healing to a coordinate produces a test that taps empty space after any layout change',
  );
});

test('an element outside the app under test is never offered either', () => {
  const analysis = analyseWithKit(
    kit,
    { nodes: screen },
    intentFor("mobileApp.tap({ accessibilityId: 'statusClock' })"),
  );
  assert.ok(
    !analysis.candidates.some(candidate => candidate.strategy === 'accessibilityId'),
    'that locator cannot resolve on replay at all',
  );
});

test('the ranking leads with the most stable identifier', () => {
  const analysis = analyseWithKit(
    kit,
    { nodes: screen },
    intentFor("mobileApp.tap({ text: 'Log in' })"),
  );
  assert.equal(analysis.candidates[0].strategy, 'resourceId');
  assert.equal(analysis.candidates[0].code, '{ resourceId: "com.example:id/submit" }');
});

// --- the proof ------------------------------------------------------------------------------------

test('one identifier is not a proof, however good the candidate is', () => {
  const intent = intentFor("mobileApp.tap({ text: 'Log in' })");
  const analysis = analyseWithKit(kit, { nodes: screen }, intent);
  const proof = proveMobile(kit, intent, analysis.candidates[0], { nodes: screen });
  assert.notEqual(proof.verdict, 'proven');
  assert.match(proof.reasons.join(' '), /insufficient-signals/);
});

test('two independent identifiers, on one element, is a proof', () => {
  const intent = intentFor(
    "mobileApp.tap({ resourceId: 'com.example:id/submit', text: 'Log in' })",
  );
  const analysis = analyseWithKit(kit, { nodes: screen }, intent);
  const proof = proveMobile(kit, intent, analysis.candidates[0], { nodes: screen });
  assert.equal(proof.verdict, 'proven');
  assert.deepEqual(proof.matched.sort(), ['resourceId', 'text']);
});

test('a replacement that matches several elements is never proven', () => {
  const intent = intentFor(
    "mobileApp.tap({ resourceId: 'com.example:id/submit', text: 'Log in' })",
  );
  // Force the text candidate, which two nodes carry.
  const textCandidate = analyseWithKit(kit, { nodes: screen }, intent).candidates.find(
    candidate => candidate.strategy === 'text',
  );
  assert.ok(textCandidate !== undefined);
  const proof = proveMobile(kit, intent, textCandidate, { nodes: screen });
  assert.notEqual(proof.verdict, 'proven');
  assert.equal(proof.uniqueMatches, 2);
});

// --- rendering ------------------------------------------------------------------------------------

test('a rendered locator reads like one a human would have written', () => {
  assert.equal(
    renderLocator({ accessibilityId: 'loginButton' }),
    '{ accessibilityId: "loginButton" }',
  );
  assert.equal(renderLocator({ text: 'Log in', index: 2 }), '{ text: "Log in", index: 2 }');
});

test('a coordinate renders as nothing, because nothing may write one', () => {
  assert.equal(renderLocator({ x: 1, y: 2 }), '{  }');
});
