/**
 * Trust-boundary tests. `parseClientMessage` is the only thing standing between an untrusted client and
 * a driver adapter that will happily drive a real device, so these tests are written from the attacker's
 * side: for every action, assert that a well-formed payload is accepted AND that a payload missing or
 * mistyping a required field is rejected. The field expectations are architecture.md §5's table.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseClientMessage } from '../src/service/protocol.js';

/** Wrap an action in the message that carries it, the way the UI does. */
const perform = (action: unknown): unknown => ({ type: 'perform', action });

function accepts(action: unknown, what: string): void {
  assert.ok(parseClientMessage(perform(action)) !== null, `should accept ${what}`);
}

function rejects(action: unknown, what: string): void {
  assert.equal(parseClientMessage(perform(action)), null, `should reject ${what}`);
}

test('rejects anything that is not a tagged message', () => {
  for (const junk of [null, undefined, 42, 'listDrivers', [], {}, { type: 7 }]) {
    assert.equal(parseClientMessage(junk), null, `should reject ${JSON.stringify(junk)}`);
  }
});

test('rejects an unknown message type and an unknown action kind', () => {
  assert.equal(parseClientMessage({ type: 'rm -rf' }), null);
  rejects({ kind: 'installMalware', locator: { text: 'ok' } }, 'an unknown action kind');
});

test('accepts every locator strategy, and rejects a locator with none', () => {
  accepts({ kind: 'tap', locator: { accessibilityId: 'login' } }, 'an accessibilityId locator');
  accepts({ kind: 'tap', locator: { resourceId: 'app:id/login' } }, 'a resourceId locator');
  accepts({ kind: 'tap', locator: { text: 'Log in' } }, 'a text locator');
  accepts({ kind: 'tap', locator: { point: { x: 10, y: 20 } } }, 'a coordinate locator');
  accepts({ kind: 'tap', locator: { native: { anything: true } } }, 'the native escape hatch');

  rejects({ kind: 'tap', locator: {} }, 'a locator with no strategy at all');
  rejects({ kind: 'tap', locator: { label: 'just a label' } }, 'a label-only locator');
  rejects({ kind: 'tap' }, 'a tap with no locator');
  rejects({ kind: 'tap', locator: 'login' }, 'a string where a locator object belongs');
  rejects({ kind: 'tap', locator: { accessibilityId: 42 } }, 'a non-string accessibilityId');
  rejects({ kind: 'tap', locator: { point: { x: 10 } } }, 'a point missing an axis');
  rejects({ kind: 'tap', locator: { point: { x: '10', y: '20' } } }, 'a stringly-typed point');
});

test('fill requires a string value — the hole that used to reach the adapter', () => {
  accepts({ kind: 'fill', locator: { text: 'Email' }, value: '' }, 'an empty but present value');
  rejects({ kind: 'fill', locator: { text: 'Email' } }, 'a fill with no value');
  rejects({ kind: 'fill', locator: { text: 'Email' }, value: 42 }, 'a non-string value');
});

test('swipe and scroll require a real direction', () => {
  accepts({ kind: 'swipe', direction: 'up' }, 'a cardinal direction');
  accepts({ kind: 'scroll', direction: 'down' }, 'a cardinal direction');
  rejects({ kind: 'swipe', direction: 'sideways' }, 'an invented direction');
  rejects({ kind: 'swipe' }, 'a swipe with no direction');
  rejects({ kind: 'scroll', direction: 'UP' }, 'the wrong case');
});

test('swipe distance is a fraction of the screen, not an arbitrary number', () => {
  accepts({ kind: 'swipe', direction: 'up', options: { distance: 0.75 } }, 'a valid fraction');
  accepts({ kind: 'swipe', direction: 'up', options: {} }, 'an empty options bag');
  rejects({ kind: 'swipe', direction: 'up', options: { distance: 42 } }, 'a distance above 1');
  rejects({ kind: 'swipe', direction: 'up', options: { distance: -1 } }, 'a negative distance');
  rejects(
    { kind: 'swipe', direction: 'up', options: { durationMs: 'fast' } },
    'a non-numeric duration',
  );
});

test('scroll `within` must itself be a valid locator', () => {
  accepts(
    { kind: 'scroll', direction: 'down', options: { within: { text: 'List' } } },
    'a container',
  );
  rejects(
    { kind: 'scroll', direction: 'down', options: { within: {} } },
    'an empty container locator',
  );
});

test('drag accepts a locator or a point on either end', () => {
  accepts({ kind: 'drag', from: { x: 1, y: 2 }, to: { text: 'Trash' } }, 'mixed target kinds');
  rejects({ kind: 'drag', from: { x: 1, y: 2 } }, 'a drag with no destination');
  rejects({ kind: 'drag', from: {}, to: { x: 1, y: 2 } }, 'an unusable origin');
});

test('pinch requires a positive, finite scale', () => {
  accepts({ kind: 'pinch', scale: 2 }, 'a zoom-in scale');
  accepts({ kind: 'pinch', scale: 0.5 }, 'a zoom-out scale');
  rejects({ kind: 'pinch', scale: 0 }, 'a zero scale');
  rejects({ kind: 'pinch', scale: -2 }, 'a negative scale');
  rejects({ kind: 'pinch', scale: Number.POSITIVE_INFINITY }, 'an infinite scale');
  rejects({ kind: 'pinch' }, 'a pinch with no scale');
});

test('pressKey requires a non-empty key, back requires nothing', () => {
  accepts({ kind: 'pressKey', key: 'enter' }, 'a key name');
  rejects({ kind: 'pressKey', key: '' }, 'an empty key');
  rejects({ kind: 'pressKey' }, 'a pressKey with no key');
  accepts({ kind: 'back' }, 'a bare back');
});

test('isVisible is accepted as a first-class action with an optional timeout', () => {
  accepts({ kind: 'isVisible', locator: { text: 'Dashboard' } }, 'a visibility query');
  accepts(
    { kind: 'isVisible', locator: { text: 'Dashboard' }, options: { timeoutMs: 5000 } },
    'a visibility query with a timeout',
  );
  rejects({ kind: 'isVisible', locator: {} }, 'a visibility query with no strategy');
  rejects(
    { kind: 'isVisible', locator: { text: 'x' }, options: { timeoutMs: 'soon' } },
    'a non-numeric timeout',
  );
});

test('screenshot and aiAssert validate their own fields', () => {
  accepts({ kind: 'screenshot' }, 'an unnamed screenshot');
  accepts({ kind: 'screenshot', name: 'home' }, 'a named screenshot');
  rejects({ kind: 'screenshot', name: 42 }, 'a non-string screenshot name');

  accepts({ kind: 'aiAssert', rubric: 'the cart shows 2 items' }, 'a rubric');
  rejects({ kind: 'aiAssert' }, 'an aiAssert with no rubric');
  rejects({ kind: 'aiAssert', rubric: '' }, 'an empty rubric');
});

test('record carries the same validation as perform', () => {
  assert.ok(parseClientMessage({ type: 'record', action: { kind: 'back' } }) !== null);
  assert.equal(parseClientMessage({ type: 'record', action: { kind: 'fill' } }), null);
});

test('connect requires a known platform and an options object', () => {
  assert.ok(
    parseClientMessage({ type: 'connect', driver: 'appium', options: { platform: 'android' } }) !==
      null,
  );
  assert.equal(parseClientMessage({ type: 'connect', driver: 'appium', options: {} }), null);
  assert.equal(
    parseClientMessage({ type: 'connect', driver: 'appium', options: { platform: 'windows' } }),
    null,
  );
  assert.equal(parseClientMessage({ type: 'connect', options: { platform: 'ios' } }), null);
});

test('pointer messages require numeric coordinates', () => {
  assert.ok(parseClientMessage({ type: 'tapAt', x: 1, y: 2, frameId: 0 }) !== null);
  assert.equal(parseClientMessage({ type: 'tapAt', x: '1', y: 2, frameId: 0 }), null);
  assert.equal(parseClientMessage({ type: 'inspectAt', x: 1, y: 2 }), null);
});

test('save requires a mode, a path, a title and a source', () => {
  const valid = {
    type: 'save',
    mode: 'new',
    targetPath: 'tests/login',
    testName: 'login',
    source: '',
  };
  assert.ok(parseClientMessage(valid) !== null);
  assert.equal(parseClientMessage({ ...valid, mode: 'overwrite' }), null);
  assert.equal(parseClientMessage({ ...valid, targetPath: 42 }), null);
  assert.equal(parseClientMessage({ ...valid, source: undefined }), null);
});
