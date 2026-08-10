/**
 * Code generation tests. Scoped for now to the visibility statements, because those are the ones
 * architecture.md ADR-004 changes: the old `expect(await app.isVisible(...)).toBe(false)` form could
 * never pass — the adapters threw on absence, so the facade threw instead of returning `false`, and every
 * generated "assert not visible" failed. The `expect.poll` form both fixes that and gives the generated
 * test its own waiting semantics instead of inheriting whatever timeout a driver happens to apply.
 *
 * The rest of the generator (the `test.use({ mobileTarget })` header, `platform`/`appId` emission) is
 * covered once Phase 0 lands its naming change, so these assertions deliberately do not pin the facade
 * identifier.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateTestSource, statementForAction } from '../src/service/codegen.js';

test('visibility is generated as expect.poll, never as expect(await …)', () => {
  const visible = statementForAction({ kind: 'assertVisible', locator: { text: 'Dashboard' } });
  const hidden = statementForAction({ kind: 'assertNotVisible', locator: { text: 'Spinner' } });

  assert.match(visible, /^await expect\.poll\(\(\) => \w+\.isVisible\(/);
  assert.match(visible, /\)\.toBe\(true\);$/);
  assert.match(hidden, /^await expect\.poll\(\(\) => \w+\.isVisible\(/);
  assert.match(hidden, /\)\.toBe\(false\);$/);

  for (const statement of [visible, hidden]) {
    assert.doesNotMatch(
      statement,
      /expect\(await /,
      'the awaited form cannot express "not visible" — see ADR-004',
    );
  }
});

test('the isVisible query action generates a positive poll', () => {
  assert.equal(
    statementForAction({ kind: 'isVisible', locator: { accessibilityId: 'cart' } }),
    'await expect.poll(() => mobileApp.isVisible({ accessibilityId: "cart" })).toBe(true);',
  );
});

test('locator literals carry exactly the strategy that was recorded', () => {
  assert.match(
    statementForAction({ kind: 'tap', locator: { accessibilityId: 'loginButton' } }),
    /\{ accessibilityId: "loginButton" \}/,
  );
  assert.match(
    statementForAction({ kind: 'tap', locator: { point: { x: 12, y: 34 } } }),
    /\{ point: \{ x: 12, y: 34 \} \}/,
  );
  // `label` is UI-only metadata and must never leak into generated code.
  assert.doesNotMatch(
    statementForAction({ kind: 'tap', locator: { text: 'Log in', label: 'the login button' } }),
    /label/,
  );
});

test('fill escapes its value rather than concatenating it raw', () => {
  const statement = statementForAction({
    kind: 'fill',
    locator: { text: 'Email' },
    value: 'a"b\\c',
  });

  assert.ok(statement.includes(JSON.stringify('a"b\\c')), `unescaped value in: ${statement}`);
});

test('a generated file is a complete test wired to the fixture barrel', () => {
  const source = generateTestSource({
    target: { driver: 'appium', platform: 'android', device: 'Pixel_7_API_34' },
    testName: 'recorded flow',
    actions: [{ kind: 'tap', locator: { accessibilityId: 'loginButton' } }],
  });

  assert.match(source, /^import \{ test, expect \} from '@fixtures';/);
  // Titles are emitted via JSON.stringify, so they are double-quoted; the project's own Prettier
  // normalizes quote style when the file is written (see RecorderSession.save).
  assert.match(source, /test\("recorded flow", async \(\{ mobileApp \}\) => \{/);
  assert.ok(source.trimEnd().endsWith('});'), `unterminated test body:\n${source}`);
});

test('the header emits platform and appId — the fields whose absence made every test unrunnable', () => {
  const source = generateTestSource({
    target: {
      driver: 'appium',
      platform: 'android',
      device: 'Pixel_7_API_34',
      appId: 'com.example.app',
    },
    testName: 'recorded flow',
    actions: [],
  });

  assert.match(
    source,
    /test\.use\(\{ mobileTarget: \{ driver: "appium", platform: "android", device: "Pixel_7_API_34", appId: "com\.example\.app" \} \}\);/,
  );
});

test('the header omits fields that were never selected rather than emitting empty strings', () => {
  const source = generateTestSource({
    target: { driver: 'maestro', platform: 'ios', appId: '' },
    testName: 'no device pinned',
    actions: [],
  });

  assert.match(source, /mobileTarget: \{ driver: "maestro", platform: "ios" \}/);
  assert.doesNotMatch(source, /device:/);
  assert.doesNotMatch(source, /appId:/, 'an empty appId must be omitted, not emitted as ""');
});

test('an empty recording still generates a valid, runnable test file', () => {
  const source = generateTestSource({
    target: { driver: 'maestro', platform: 'android' },
    testName: 'empty',
    actions: [],
  });

  assert.match(source, /\/\/ Recorded actions will appear here\./);
  assert.ok(source.trimEnd().endsWith('});'));
});

test('every action kind generates a statement, including the ones added with the IR extension', () => {
  // The switch is exhaustive by type, so a missing branch is a compile error rather than a test failure —
  // what this pins is the shape of what it emits, since that is what has to compile inside a real test.
  const statements = [
    statementForAction({ kind: 'doubleTap', locator: { text: 'Row' } }),
    statementForAction({ kind: 'eraseText', locator: { accessibilityId: 'email' } }),
    statementForAction({
      kind: 'eraseText',
      locator: { accessibilityId: 'email' },
      options: { characters: 3 },
    }),
    statementForAction({ kind: 'hideKeyboard' }),
    statementForAction({ kind: 'scrollUntilVisible', locator: { text: 'Row 40' } }),
    statementForAction({
      kind: 'scrollUntilVisible',
      locator: { text: 'Row 40' },
      options: { direction: 'down' },
    }),
  ];

  assert.deepEqual(statements, [
    'await mobileApp.doubleTap({ text: "Row" });',
    'await mobileApp.eraseText({ accessibilityId: "email" });',
    'await mobileApp.eraseText({ accessibilityId: "email" }, { characters: 3 });',
    'await mobileApp.hideKeyboard();',
    'await mobileApp.scrollUntilVisible({ text: "Row 40" });',
    'await mobileApp.scrollUntilVisible({ text: "Row 40" }, { direction: "down" });',
  ]);
});

test('an ordinal is emitted last, alongside the strategy it counts', () => {
  // `index` is not a strategy: on its own it addresses nothing, so it always accompanies one.
  assert.equal(
    statementForAction({ kind: 'tap', locator: { text: 'Delete', index: 1 } }),
    'await mobileApp.tap({ text: "Delete", index: 1 });',
  );
});
