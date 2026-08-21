/**
 * Fingerprints. Two properties carry real weight downstream:
 *
 * - the same failure must hash identically under a TTY and in CI, which is why ANSI stripping is not
 *   cosmetic;
 * - a changed *value* must move `errorFingerprint` and leave `siteFingerprint` alone. That is the
 *   only reason a later phase can detect a heal that pointed at the wrong element.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { callLogLines, displayMessage, normalizeMessage, stripAnsi } from '../src/triage/ansi.js';
import { errorFingerprint, siteFingerprint } from '../src/triage/fingerprint.js';

const SITE = {
  kind: 'value-mismatch' as const,
  matcher: 'toHaveText',
  locatorCode: "locator('#greet')",
  topFrame: { file: 'tests/mix.spec.ts', line: 22 },
};

test('ANSI is stripped, and plain brackets are left alone', () => {
  assert.equal(stripAnsi('\x1b[31mReceived:\x1b[39m "a"'), 'Received: "a"');
  assert.equal(stripAnsi('items[0] and arr[2a] survive'), 'items[0] and arr[2a] survive');
});

test('a colourised message normalises to the same string as a plain one', () => {
  const plain = 'expect(locator).toHaveText(expected) failed\n\nExpected: "a"\nReceived: "b"\n';
  const coloured = plain.replace('Received:', '\x1b[31mReceived:\x1b[39m');
  assert.equal(normalizeMessage(coloured), normalizeMessage(plain));
});

test('the call log and the timeout line are dropped, so timing never enters an identity', () => {
  const withLog = `expect(locator).toBeVisible() failed

Locator: getByTestId('x')
Timeout: 1500ms

Call log:
  - Expect "toBeVisible" with timeout 1500ms
  - waiting for getByTestId('x')
`;
  const normalized = normalizeMessage(withLog);
  assert.equal(normalized.includes('Call log'), false);
  assert.equal(normalized.includes('1500ms'), false);
  assert.match(normalized, /getByTestId\('x'\)/);
});

test('a code snippet is dropped, so an edit above the failure does not change the hash', () => {
  const before =
    'expect(received).toBe(expected)\n\nExpected: 3\nReceived: 2\n\n  49 |\n> 51 |   expect(1 + 1).toBe(3);\n     |                 ^\n';
  const after = before.replace('49', '81').replace('51', '83');
  assert.equal(normalizeMessage(after), normalizeMessage(before));
});

test('absolute paths normalise against the project root, so two machines agree', () => {
  const a = normalizeMessage('failed at /Users/ada/suite/tests/a.spec.ts', {
    rootDir: '/Users/ada/suite',
  });
  const b = normalizeMessage('failed at /home/ci/work/tests/a.spec.ts', {
    rootDir: '/home/ci/work',
  });
  assert.equal(a, b);
});

test('the same site with a different received value keeps its siteFingerprint', () => {
  const site = siteFingerprint(SITE);
  const first = errorFingerprint({ ...SITE, expected: '"Ada"', received: '"Ada"' });
  const second = errorFingerprint({ ...SITE, expected: '"Ada"', received: '"Grace"' });

  assert.equal(siteFingerprint(SITE), site, 'the site is a function of place and kind only');
  assert.notEqual(first, second, 'a changed value must change the error fingerprint');
  // The property a later mask detector depends on: same place, different data.
  assert.equal(siteFingerprint({ ...SITE }), site);
});

test('a different place, matcher or kind is a different site', () => {
  const site = siteFingerprint(SITE);
  assert.notEqual(siteFingerprint({ ...SITE, matcher: 'toHaveValue' }), site);
  assert.notEqual(siteFingerprint({ ...SITE, locatorCode: "locator('#other')" }), site);
  assert.notEqual(siteFingerprint({ ...SITE, kind: 'presence-timeout' }), site);
  assert.notEqual(
    siteFingerprint({ ...SITE, topFrame: { file: 'tests/mix.spec.ts', line: 23 } }),
    site,
  );
});

test('with no values reported, the error fingerprint falls back to the normalised message', () => {
  const base = { kind: 'unknown' as const, topFrame: { file: 'tests/a.spec.ts', line: 1 } };
  const same = errorFingerprint({ ...base, message: 'Error: boom at 12:30:01' });
  const alsoSame = errorFingerprint({ ...base, message: 'Error: boom at 18:44:52' });
  const different = errorFingerprint({ ...base, message: 'Error: something else' });
  assert.equal(same, alsoSame, 'numbers collapse, so a timestamp does not split a cluster');
  assert.notEqual(same, different);
});

test('displayMessage keeps the message readable and drops the call log', () => {
  const raw = 'Error: nope\n\nCall log:\n  - waiting\n';
  assert.equal(displayMessage(raw), 'Error: nope');
});

test('callLogLines returns the waiting lines, capped', () => {
  const raw = `Error: nope\n\nCall log:\n${Array.from({ length: 30 }, (_, i) => `  - step ${i}`).join('\n')}`;
  const lines = callLogLines(raw, 5);
  assert.equal(lines.length, 5);
  assert.equal(lines[0], '- step 0');
  assert.deepEqual(callLogLines('Error: no log here'), []);
});
