/**
 * Mobile error strings, pinned verbatim.
 *
 * The web taxonomy was captured by generating real Playwright failures. That is impossible for these
 * without a booted device, so each pattern was taken from an installed source instead — `webdriver`
 * 9.30.0 and this repo's own adapters — and **each test names where its string came from**. That is the
 * whole value of this file: an Appium or WebdriverIO upgrade that changes a message breaks our CI here,
 * loudly, rather than silently reclassifying every mobile failure in a user's project.
 *
 * The most important assertion is the one that looks least like one: a driver error whose element was
 * *found* must never be readable as drift. Repointing a correct locator at some other element that
 * happens to be tappable is the mobile form of hiding a bug.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classify } from '../src/triage/classify.js';
import { classifyError } from '../src/triage/errorTaxonomy.js';
import type { ErrorKind, FailureRecord } from '../src/types.js';
import { TAXONOMY_VERSION } from '../src/types.js';

const kindOf = (
  message: string,
  over: Partial<Parameters<typeof classifyError>[0]> = {},
): ErrorKind => classifyError({ message, status: 'failed', ...over }).kind;

/** The wrapper every WebdriverIO error message carries — `webdriver@9.30.0` build/index.js:2016. */
const wd = (serverMessage: string): string =>
  `WebDriverError: ${serverMessage} when running "element" with method "POST" and args {"using":"accessibility id","value":"loginButton"}`;

/**
 * The wrapper `mobile-core` puts around every failed action — `fixture.ts:167`. Nothing reaches the
 * reporter without it, so every pattern above has to survive being nested inside it.
 */
const wrapped = (kindName: string, inner: string): string =>
  `[mobile-inspector] "${kindName}" failed: ${inner}`;

// --- found nothing --------------------------------------------------------------------------------

test('Appium: "no such element" reads as a presence timeout', () => {
  // webdriver@9.30.0 build/index.js:1418 — the Appium branch, matched lowercase-prefixed.
  assert.equal(kindOf(wd('no such element: An element could not be located')), 'presence-timeout');
});

test('the Internet Explorer / JSONWire phrasing reads the same', () => {
  // webdriver@9.30.0 build/index.js:1419, verbatim including the full stop.
  assert.equal(
    kindOf(wd('An element could not be located on the page using the given search parameters.')),
    'presence-timeout',
  );
});

test('the "unable to find element" phrasing reads the same', () => {
  // webdriver@9.30.0 build/index.js:1420.
  assert.equal(kindOf(wd('unable to find element')), 'presence-timeout');
});

test("Maestro's own wait reports the same fact in its own words", () => {
  // plugin-maestro/src/inspector.ts:481.
  assert.equal(
    kindOf('[maestro-inspector] waitFor timed out — element never became visible'),
    'presence-timeout',
  );
});

test('a mobile presence timeout is the SAME kind the web path uses', () => {
  // This is what mobile parity actually is: one kind, so every weight, band, veto and gate downstream
  // works on mobile without knowing mobile exists.
  assert.equal(kindOf(wd('no such element')), kindOf('expect(locator).toBeVisible() failed'));
});

test('every pattern still reads correctly through the action wrapper', () => {
  // This is the shape the reporter actually stores. A taxonomy written against the bare driver message
  // would match nothing in production, and the mistake would be invisible in a unit test that skipped
  // the wrapper.
  assert.equal(kindOf(wrapped('tap', wd('no such element'))), 'presence-timeout');
  assert.equal(kindOf(wrapped('fill', wd('stale element reference'))), 'stale-element');
  assert.equal(kindOf(wrapped('tap', wd('element not interactable'))), 'not-interactable');
  assert.equal(kindOf(wrapped('tap', wd('invalid session id'))), 'browser-crash');
});

test('a driver message that merely contains "does not support" is not a capability gap', () => {
  // The loose phrase was the first attempt and it is wrong: this is an element that is not there, and
  // reading it as a capability gap would tell a human to change the test when the app had moved.
  assert.equal(
    kindOf(
      wrapped('tap', wd('no such element: this locator strategy does not support shadow roots')),
    ),
    'presence-timeout',
  );
});

// --- found, but --------------------------------------------------------------------------------

test('a stale element reference is a race, not a moved element', () => {
  // webdriver@9.30.0 build/index.js:2079.
  assert.equal(kindOf(wd('stale element reference: element is not attached')), 'stale-element');
});

test('an element that will not accept input is not a moved element either', () => {
  assert.equal(kindOf(wd('element not interactable')), 'not-interactable');
});

test('neither of those can ever be classified as something repairable', () => {
  for (const kind of ['stale-element', 'not-interactable'] as ErrorKind[]) {
    const triage = classify({
      outcome: 'unexpected',
      failure: {
        kind,
        message: 'x',
        siteFingerprint: 's',
        errorFingerprint: 'e',
        taxonomyVersion: TAXONOMY_VERSION,
        attachments: [],
      } satisfies FailureRecord,
      // Give it every reason to read as drift: a clean repository and a long green history.
      history: {
        runs: 20,
        fails: 1,
        flakyRuns: 0,
        flakeRate: 0.05,
        recoveryRate: 0,
        neverPassed: false,
        lastPassed: '2026-08-20T00:00:00.000Z',
        sites: [],
      },
      testFileChanged: false,
      topFrameFileChanged: false,
      configRetries: 1,
    });
    assert.notEqual(triage.class, 'locator-drift', kind);
    assert.ok(
      triage.vetoes.some(veto => veto.startsWith('locator-resolved:')),
      `${kind} must say why there is nothing to repair`,
    );
  }
});

// --- the driver, the tooling, the test's own mistake ----------------------------------------------

test('a dead or unreachable session is infrastructure', () => {
  for (const message of [
    // webdriver@9.30.0 build/index.js:2292.
    wd('invalid session id'),
    'A session is either terminated or not started',
    'Could not proxy command to the remote server',
    // plugin-maestro/src/core/McpClient.ts.
    "[mobile] 'maestro mcp' is not running",
    'Failed to connect to 127.0.0.1:7001',
    // plugin-maestro/src/core/appInstaller.ts.
    '[mobile] adb install failed (exit 1): device offline',
    '[mobile] simctl install failed (exit 1)',
    '[mobile] app download failed (HTTP 404): https://example.test/app.apk',
  ]) {
    assert.equal(kindOf(message), 'browser-crash', message);
  }
});

test('a gesture the driver cannot perform is a capability gap, and never a repair', () => {
  // mobile-core/src/types.ts:410 — UnsupportedActionError.
  const unsupported = kindOf(
    '[mobile-inspector] driver "maestro" does not support "pinch" actions',
  );
  assert.equal(unsupported, 'driver-unsupported');
  // plugin-maestro/src/inspector.ts:471.
  assert.equal(
    kindOf('[maestro-inspector] pinch is not supported by the Maestro driver'),
    'driver-unsupported',
  );

  const triage = classify({
    outcome: 'unexpected',
    failure: {
      kind: 'driver-unsupported',
      message: 'x',
      siteFingerprint: 's',
      errorFingerprint: 'e',
      taxonomyVersion: TAXONOMY_VERSION,
      attachments: [],
    },
    configRetries: 1,
  });
  assert.equal(triage.class, 'true-fail');
  assert.ok(triage.vetoes.some(veto => veto.startsWith('driver-unsupported:')));
});

test('a capability gap thrown inside the fixture is not read as setup breaking', () => {
  // It IS thrown from the fixture's action path, so the step category says `fixture` — and that would
  // otherwise make it env-infra, which would tell a human to re-run the job forever.
  assert.equal(
    kindOf('[mobile-inspector] driver "appium" does not support "pinch" actions', {
      failingStepCategory: 'fixture',
    }),
    'driver-unsupported',
  );
});

test('a selector the driver refused is the test being wrong, not the app moving', () => {
  // webdriver@9.30.0 build/index.js:2072 rewrites an invalid locator into this exact sentence.
  assert.equal(
    kindOf(wd('The selector "//*[" used with strategy "xpath" is invalid!')),
    'value-mismatch',
  );
});

test('an ordinary application assertion on mobile still reads as a value mismatch', () => {
  // Nothing above may shadow the web path: a mobile test asserting on text uses the same matcher.
  assert.equal(
    kindOf('expect(received).toBe(expected) failed\n\nExpected: "3"\nReceived: "2"'),
    'value-mismatch',
  );
});
