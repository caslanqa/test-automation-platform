/**
 * The highest-value test in this package: every message below was **captured from a real Playwright
 * 1.61 run**, not paraphrased from docs. The entire classifier rests on these strings, so an upgrade
 * that changes one must break our CI loudly rather than silently reclassify every failure in every
 * user's suite.
 *
 * Five of these encode a correction the docs would have led me to get wrong — see the notes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyError } from '../src/triage/errorTaxonomy.js';

// --- verbatim Playwright 1.61 messages -------------------------------------------------------

/** NOTE: the not-found variant has **no `Received:` line** — it ends with `Error: element(s) not found`. */
const NOT_FOUND = `expect(locator).toBeVisible() failed

Locator: getByTestId('nope')
Expected: visible
Timeout: 1500ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 1500ms
  - waiting for getByTestId('nope')
`;

/** NOTE: `Locator:` here has **two** spaces after it. The label padding varies with the block. */
const HIDDEN = `expect(locator).toBeVisible() failed

Locator:  locator('#hidden')
Expected: visible
Received: hidden
Timeout:  1500ms

Call log:
  - Expect "toBeVisible" with timeout 1500ms
  - waiting for locator('#hidden')
`;

/** NOTE: prefixed by the action — `locator.click: Error: strict mode violation: …`. */
const STRICT = `locator.click: Error: strict mode violation: locator('.dup') resolved to 2 elements:
    1) <button class="dup">X</button> aka getByRole('button', { name: 'X' }).first()
    2) <button class="dup">X</button> aka getByRole('button', { name: 'X' }).nth(1)

Call log:
  - waiting for locator('.dup')
`;

/** NOTE: the prefix is `TimeoutError`, and `waiting for` lives in the **call log**, not the message. */
const ACTION_TIMEOUT = `locator.click: Timeout 1500ms exceeded.

Call log:
  - waiting for locator('#does-not-exist')
`;

const VALUE_MISMATCH = `expect(locator).toHaveText(expected) failed

Locator:  locator('#greet')
Expected: "Welcome, Grace"
Received: "Welcome, Ada"
Timeout:  1500ms
`;

const COUNT_MISMATCH = `expect(locator).toHaveCount(expected) failed

Locator:  locator('.dup')
Expected: 0
Received: 2
Timeout:  1500ms
`;

const COUNT_ZERO = `expect(locator).toHaveCount(expected) failed

Locator:  locator('.absent')
Expected: 3
Received: 0
Timeout:  1500ms
`;

const NETWORK = `page.goto: net::ERR_UNSAFE_PORT at http://127.0.0.1:9/nothing

Call log:
  - navigating to "http://127.0.0.1:9/nothing", waiting until "load"
`;

/** NOTE: a plain value assertion has **no `Locator:` line** and carries a code snippet. */
const PLAIN_TO_BE = `expect(received).toBe(expected) // Object.is equality

Expected: 3
Received: 2

  49 |
  50 | test('plain toBe mismatch', async () => {
> 51 |   expect(1 + 1).toBe(3);
     |                 ^
`;

/** NOTE: a test timeout **does** produce an error — the docs-driven guess was "no error at all". */
const TEST_TIMEOUT = 'Test timeout of 1200ms exceeded.';

const CRASH = 'page.click: Target page, context or browser has been closed';

// --- assertions ------------------------------------------------------------------------------

test('a presence matcher that found nothing is presence-timeout, with no Received line', () => {
  const facts = classifyError({ message: NOT_FOUND, status: 'failed' });
  assert.equal(facts.kind, 'presence-timeout');
  assert.equal(facts.matcher, 'toBeVisible');
  assert.equal(facts.locatorCode, "getByTestId('nope')");
  assert.equal(facts.expected, 'visible');
  assert.equal(facts.received, undefined, 'the not-found variant reports no Received');
  assert.equal(facts.timeoutMs, 1500);
});

test('a hidden element is presence-timeout, and the two-space label still parses', () => {
  const facts = classifyError({ message: HIDDEN, status: 'failed' });
  assert.equal(facts.kind, 'presence-timeout');
  assert.equal(
    facts.locatorCode,
    "locator('#hidden')",
    'the extra space must not become part of it',
  );
  assert.equal(facts.received, 'hidden');
});

test('a strict-mode violation is its own kind, and the selector is recovered from the message', () => {
  const facts = classifyError({ message: STRICT, status: 'failed' });
  assert.equal(facts.kind, 'strict-mode');
  assert.equal(facts.locatorCode, "locator('.dup')");
});

test('an action timeout is action-timeout despite the TimeoutError prefix', () => {
  assert.equal(classifyError({ message: ACTION_TIMEOUT, status: 'failed' }).kind, 'action-timeout');
});

test('two differing values are value-mismatch — the one class that must never be healed', () => {
  const facts = classifyError({ message: VALUE_MISMATCH, status: 'failed' });
  assert.equal(facts.kind, 'value-mismatch');
  assert.equal(facts.matcher, 'toHaveText');
  assert.equal(facts.expected, '"Welcome, Grace"');
  assert.equal(facts.received, '"Welcome, Ada"');
});

test('a value assertion with no locator is still value-mismatch', () => {
  const facts = classifyError({ message: PLAIN_TO_BE, status: 'failed' });
  assert.equal(facts.kind, 'value-mismatch');
  assert.equal(facts.matcher, 'toBe');
  assert.equal(facts.locatorCode, undefined);
  assert.equal(facts.expected, '3');
  assert.equal(facts.received, '2');
});

test('toHaveCount discriminates on what was received, not on the matcher', () => {
  assert.equal(classifyError({ message: COUNT_MISMATCH, status: 'failed' }).kind, 'value-mismatch');
  assert.equal(classifyError({ message: COUNT_ZERO, status: 'failed' }).kind, 'count-zero');
});

test('a refused navigation is env-infra, not a broken locator', () => {
  assert.equal(classifyError({ message: NETWORK, status: 'failed' }).kind, 'network');
});

test('a closed page is env-infra even when a matcher name appears in the message', () => {
  assert.equal(classifyError({ message: CRASH, status: 'failed' }).kind, 'browser-crash');
  assert.equal(
    classifyError({
      message: `${CRASH}\nexpect(locator).toHaveText(expected) failed`,
      status: 'failed',
    }).kind,
    'browser-crash',
    'environment outranks a matcher that happens to be in the same message',
  );
});

test('a test timeout is recognised from its message, which does exist', () => {
  assert.equal(classifyError({ message: TEST_TIMEOUT, status: 'timedOut' }).kind, 'test-timeout');
  assert.equal(classifyError({ message: '', status: 'timedOut' }).kind, 'test-timeout');
});

test('the failing step category is what identifies a fixture failure', () => {
  // The message is only whatever the author threw, so the category is the sole discriminator —
  // verified against the real reporter API, which reports `category: 'fixture'`.
  const thrown = 'setting up the brittle fixture failed: no such host';
  assert.equal(classifyError({ message: thrown, status: 'failed' }).kind, 'unknown');
  assert.equal(
    classifyError({
      message: thrown,
      status: 'failed',
      failingStepCategory: 'fixture',
      failingStepTitle: 'Fixture "brittle"',
    }).kind,
    'fixture-error',
  );
  assert.equal(
    classifyError({ message: thrown, status: 'failed', failingStepCategory: 'hook' }).kind,
    'fixture-error',
  );
});

test('the matcher is recovered from the step title when the message does not name it', () => {
  const facts = classifyError({
    message: 'something went wrong',
    status: 'failed',
    failingStepCategory: 'expect',
    failingStepTitle: 'Expect "toHaveText" locator(\'#x\')',
  });
  assert.equal(facts.matcher, 'toHaveText');
});

test('ANSI colouring does not change the reading', () => {
  const coloured = VALUE_MISMATCH.replace('Received:', '[31mReceived:[39m');
  const facts = classifyError({ message: coloured, status: 'failed' });
  assert.equal(facts.kind, 'value-mismatch');
  assert.equal(facts.received, '"Welcome, Ada"');
});

test('an unrecognised failure is unknown rather than a confident guess', () => {
  assert.equal(classifyError({ message: 'Error: boom', status: 'failed' }).kind, 'unknown');
  assert.equal(classifyError({}).kind, 'unknown');
});
