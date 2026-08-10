/**
 * Selector translation tests.
 *
 * Maestro's `text` and `id` selectors are **regular expressions** — full-string, case-insensitive — while
 * `MobileLocator.text` and `.resourceId` are literals by contract: the visible text and the platform id of
 * an element the recorder just hit-tested. Passing one through as the other is silent: the flow is valid
 * YAML, the pattern is a valid regex, and it simply never matches the element it was recorded from. Every
 * example below is an ordinary label from a real settings screen.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { escapeMaestroPattern, toMaestroSelector } from '../src/inspector.js';

test('regex metacharacters in real UI text are escaped', () => {
  assert.equal(escapeMaestroPattern('Wi-Fi (2.4 GHz)'), 'Wi-Fi \\(2\\.4 GHz\\)');
  assert.equal(escapeMaestroPattern('Storage [internal]'), 'Storage \\[internal\\]');
  assert.equal(escapeMaestroPattern('Continue?'), 'Continue\\?');
  assert.equal(escapeMaestroPattern('50% + tax'), '50% \\+ tax');
});

test('a dollar sign is escaped too, because Maestro reads it as a variable', () => {
  // Maestro interpolates `${…}` in a flow before matching, so an unescaped `$` in a price label is read as
  // the start of a reference rather than as text (its own FAQ shows `\$150 in Cash`).
  assert.equal(escapeMaestroPattern('$150 in Cash'), '\\$150 in Cash');
});

test('a backslash is escaped before anything that follows it', () => {
  assert.equal(escapeMaestroPattern('C:\\Users'), 'C:\\\\Users');
});

test('text with no special characters is left exactly as it was', () => {
  assert.equal(escapeMaestroPattern('Log in'), 'Log in');
});

test('an accessibility id becomes a text selector, because Maestro has no separate key', () => {
  assert.deepEqual(toMaestroSelector({ accessibilityId: 'loginButton' }), { text: 'loginButton' });
});

test('a resource id becomes an escaped id selector', () => {
  // The dots in a package name are regex wildcards: unescaped, `com.example:id/login` also matches ids that
  // merely look like it, so a "unique" locator quietly stops being one.
  assert.deepEqual(toMaestroSelector({ resourceId: 'com.example:id/login' }), {
    id: 'com\\.example:id/login',
  });
});

test('a text locator is escaped', () => {
  assert.deepEqual(toMaestroSelector({ text: 'Wi-Fi (2.4 GHz)' }), {
    text: 'Wi-Fi \\(2\\.4 GHz\\)',
  });
});

test('a native selector is passed through untouched', () => {
  // The hand-authored escape hatch: a caller reaching for it is writing a Maestro selector on purpose, so
  // escaping it would break the one case where a regex is the point.
  const native = { text: '.*Continue.*', index: 1 };
  assert.deepEqual(toMaestroSelector({ native }), native);
});

test('a locator Maestro cannot express fails loudly', () => {
  assert.throws(() => toMaestroSelector({ label: 'just a label' }), /no accessibilityId/);
});

test('an ordinal is carried through as Maestro’s own index', () => {
  // Maestro counts matches from 0 exactly as the IR does, so no translation is needed — and this is the
  // candidate that lets a repeated list row be addressed by its attribute instead of by coordinate.
  assert.deepEqual(toMaestroSelector({ text: 'Delete', index: 2 }), { text: 'Delete', index: 2 });
  assert.deepEqual(toMaestroSelector({ resourceId: 'app:id/row', index: 0 }), {
    id: 'app:id/row',
    index: 0,
  });
});
