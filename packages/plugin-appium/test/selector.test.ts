/**
 * Selector translation tests.
 *
 * This is where a driver-neutral locator becomes something Appium can resolve, and both bugs it used to
 * carry were only findable on a device: an iOS text locator that could never match (because `toMobileNode`
 * fills `text` from `label` OR `value` while the selector only matched `label`), and unescaped
 * interpolation that breaks the moment real UI text contains a quote.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toAppiumSelector } from '../src/inspector.js';

test('accessibility id uses the cross-platform shorthand', () => {
  assert.equal(toAppiumSelector({ accessibilityId: 'loginButton' }, 'android'), '~loginButton');
  assert.equal(toAppiumSelector({ accessibilityId: 'loginButton' }, 'ios'), '~loginButton');
});

test('resource id maps to each platform’s own id strategy', () => {
  assert.equal(
    toAppiumSelector({ resourceId: 'com.example:id/login' }, 'android'),
    'android=new UiSelector().resourceId("com.example:id/login")',
  );
  assert.equal(
    toAppiumSelector({ resourceId: 'loginField' }, 'ios'),
    '-ios predicate string:name == "loginField"',
  );
});

test('an iOS text locator matches label OR value, because that is where text comes from', () => {
  // `toMobileNode` reads a node's `text` from `attrs.text || attrs.label || attrs.value`. Matching only
  // `label` made every locator recorded from a `value`-only element un-resolvable — the tap failed with
  // "element wasn't found" the first time it was replayed on a real simulator.
  assert.equal(
    toAppiumSelector({ text: 'Log in' }, 'ios'),
    '-ios predicate string:label == "Log in" OR value == "Log in"',
  );
});

test('an Android text locator uses UiSelector text', () => {
  assert.equal(
    toAppiumSelector({ text: 'Log in' }, 'android'),
    'android=new UiSelector().text("Log in")',
  );
});

test('quotes in real UI text are escaped, not left to break the selector', () => {
  const ios = toAppiumSelector({ text: 'He said "hi"' }, 'ios') as string;
  const android = toAppiumSelector({ text: 'He said "hi"' }, 'android') as string;

  assert.equal(
    ios,
    '-ios predicate string:label == "He said \\"hi\\"" OR value == "He said \\"hi\\""',
  );
  assert.equal(android, 'android=new UiSelector().text("He said \\"hi\\"")');
});

test('backslashes are escaped before the quotes that follow them', () => {
  // A lone trailing backslash would otherwise escape the closing quote of the literal.
  assert.equal(
    toAppiumSelector({ text: 'C:\\path' }, 'android'),
    'android=new UiSelector().text("C:\\\\path")',
  );
});

test('a resource id containing a quote is escaped too', () => {
  assert.equal(
    toAppiumSelector({ resourceId: 'weird"id' }, 'ios'),
    '-ios predicate string:name == "weird\\"id"',
  );
});

test('the native escape hatch is passed through untouched', () => {
  const native = '-ios class chain:**/XCUIElementTypeButton[2]';
  assert.equal(toAppiumSelector({ native }, 'ios'), native);
});

test('a locator with no usable strategy fails loudly', () => {
  assert.throws(
    () => toAppiumSelector({}, 'android'),
    /no accessibilityId\/resourceId\/text\/native/,
  );
  // A coordinate-only locator has no selector form; the adapter's own tap path handles points instead.
  assert.throws(() => toAppiumSelector({ point: { x: 1, y: 2 } }, 'ios'), /no accessibilityId/);
});

test('the strategy order matches the locator engine’s ranking', () => {
  // accessibilityId beats resourceId beats text, so a rich locator resolves by its most stable field.
  assert.equal(toAppiumSelector({ accessibilityId: 'a', resourceId: 'r', text: 't' }, 'ios'), '~a');
  assert.equal(
    toAppiumSelector({ resourceId: 'r', text: 't' }, 'android'),
    'android=new UiSelector().resourceId("r")',
  );
});
