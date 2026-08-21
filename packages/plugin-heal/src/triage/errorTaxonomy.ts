/**
 * Reading a Playwright failure's *shape* from its message. One file, one version, and every pattern
 * carries the Playwright version it was verified against — because this is the layer that couples us
 * to someone else's strings, and a silent reclassification after an upgrade is the failure mode.
 *
 * Every format below was captured from a **real run of Playwright 1.61**, not paraphrased from docs.
 * `packages/plugin-heal/test/errorTaxonomy.test.ts` pins them verbatim, so an upgrade that changes a
 * message breaks our CI rather than a user's triage.
 *
 * Five things the real output taught, all of which a docs-only reading would have got wrong:
 *
 * 1. The **not-found** variant of a presence failure has **no `Received:` line at all** — it ends
 *    with `Error: element(s) not found`. Only the hidden variant reports `Received: hidden`.
 * 2. `Locator:` is followed by **one or two spaces** depending on the longest label in the block.
 * 3. An action timeout is `TimeoutError: locator.click: Timeout 1500ms exceeded.` — the prefix is
 *    `TimeoutError`, and `waiting for <locator>` lives in the **call log**, not the message.
 * 4. A test timeout **does** produce an error: `Test timeout of 1200ms exceeded.`
 * 5. A plain `expect(2).toBe(3)` has **no `Locator:` line**, so a value mismatch must not require one.
 *
 * @example
 * classifyError({ message: 'Error: expect(locator).toHaveText(expected) failed\n\nExpected: "a"\nReceived: "b"' });
 * // → { kind: 'value-mismatch', matcher: 'toHaveText', expected: '"a"', received: '"b"' }
 */
import type { ErrorKind } from '../types.js';
import { stripAnsi } from './ansi.js';

/** Matchers that compare a value. A mismatch here is a behaviour change, never a moved element. */
const VALUE_MATCHERS = new Set([
  'toHaveText',
  'toContainText',
  'toHaveValue',
  'toHaveValues',
  'toHaveAttribute',
  'toHaveClass',
  'toHaveCSS',
  'toHaveId',
  'toHaveURL',
  'toHaveTitle',
  'toHaveCount',
  'toHaveScreenshot',
  'toEqual',
  'toBe',
  'toStrictEqual',
  'toMatchObject',
  'toContain',
  'toBeCloseTo',
  'toHaveLength',
]);

/** Matchers that assert an element is simply there and usable. */
const PRESENCE_MATCHERS = new Set([
  'toBeVisible',
  'toBeAttached',
  'toBeInViewport',
  'toBeEnabled',
  'toBeEditable',
  'toBeChecked',
  'toBeFocused',
  'toBeHidden',
]);

const NETWORK_SIGNS = [
  'net::ERR_',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ETIMEDOUT',
  'NS_ERROR_',
  'socket hang up',
];

/**
 * Mobile patterns, and where every one of them comes from.
 *
 * The web patterns above were captured by generating real Playwright failures. That is not possible for
 * these without a booted device, so they were taken from the **installed sources** instead, which is the
 * next most authoritative thing and is recorded here so a reader can check rather than trust:
 *
 * - `webdriver@9.30.0` `build/index.js:1418` — the three "element not found" shapes Appium, Internet
 *   Explorer and the JSONWire fallback each produce.
 * - `webdriver@9.30.0` `build/index.js:2016` — every driver error's message is literally
 *   `WebDriverError: <server message> when running "<cmd>" with method "<METHOD>"`, so the prefix is a
 *   reliable "this came from the driver, not from the app" marker.
 * - `webdriver@9.30.0` `build/index.js:2072,2079,2292` — the invalid-selector rewrite, the stale
 *   element name, and the `invalid session id` retry check.
 * - This repo's own adapters: `plugin-maestro/src/inspector.ts:471,481`,
 *   `plugin-maestro/src/core/McpClient.ts`, `plugin-maestro/src/core/appInstaller.ts`, and
 *   `mobile-core/src/types.ts:410` (`UnsupportedActionError`).
 *
 * Keyed on the message rather than on the Playwright project name, deliberately: a user may rename the
 * `appium` project, and these strings identify themselves.
 */
const MOBILE_MISSING_SIGNS = [
  'no such element',
  'An element could not be located on the page using the given search parameters.',
  'unable to find element',
  // Maestro's own wait, which reports the same fact in its own words.
  'waitFor timed out — element never became visible',
];

/** The driver, the device or the tooling around them — never the test and never the app. */
const MOBILE_INFRA_SIGNS = [
  'invalid session id',
  'A session is either terminated or not started',
  'Could not proxy command',
  'Failed to create session',
  "'maestro mcp' is not running",
  'Failed to connect to 127.0.0.1',
  'adb install failed',
  'simctl install failed',
  'app download failed',
  'app artifact not found',
  'no .app bundle found inside',
];

/**
 * The test asked for something the driver cannot do. A human decision, never a repair.
 *
 * Anchored on the exact sentences the two throw sites produce rather than on a phrase like
 * "does not support". Every mobile failure arrives wrapped as
 * `[mobile-inspector] "tap" failed: <driver message>`, so a loose phrase would also match a *driver*
 * error that happened to contain it — and misreading a missing element as a capability gap would tell a
 * human to change the test when the app had moved.
 */
const MOBILE_UNSUPPORTED_PATTERNS = [
  // mobile-core/src/types.ts:410 — UnsupportedActionError.
  /driver "[^"]+" does not support "[^"]+" actions/,
  // plugin-maestro/src/inspector.ts:471.
  /is not supported by the Maestro driver/,
  // plugin-maestro/src/inspector.ts:507 — an action the adapter has no branch for at all.
  /unhandled action:/,
];

const CRASH_SIGNS = [
  'Target page, context or browser has been closed',
  'Target crashed',
  'Browser has been closed',
  'browserContext.close',
  'Protocol error',
  'Execution context was destroyed',
  'Navigation failed because page was closed',
];

export interface ErrorFacts {
  kind: ErrorKind;
  matcher?: string;
  locatorCode?: string;
  expected?: string;
  received?: string;
  timeoutMs?: number;
}

export interface ClassifyErrorInput {
  /** The raw first error message. ANSI is stripped here, so callers need not. */
  message?: string;
  /** `TestResult.status`, which is the only signal when the message is absent. */
  status?: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  /** The deepest erroring step's category — `fixture`/`hook` is the env-infra discriminator. */
  failingStepCategory?: string;
  /** The deepest erroring step's title, which also carries the matcher and the locator. */
  failingStepTitle?: string;
}

/** `Label: value` from the matcher block, tolerating the variable label padding. */
function labelled(text: string, label: string): string | undefined {
  const match = new RegExp(`^\\s*${label}:[ \\t]*(.*)$`, 'm').exec(text);
  const value = match?.[1]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** `expect(locator).toHaveText(expected) failed` and `expect(received).toBe(expected) // …`. */
function matcherFromMessage(text: string): string | undefined {
  return /\bexpect\([^)]*\)(?:\.[a-zA-Z]+)*\.(\w+)\(/.exec(text)?.[1];
}

/** `Expect "toHaveText" locator('#x')` — the step title, when the message did not say. */
function matcherFromStep(title: string | undefined): string | undefined {
  return title === undefined ? undefined : /^Expect "([^"]+)"/.exec(title)?.[1];
}

export function classifyError(input: ClassifyErrorInput): ErrorFacts {
  const text = stripAnsi(input.message ?? '');
  const matcher = matcherFromMessage(text) ?? matcherFromStep(input.failingStepTitle);
  const locatorCode = labelled(text, 'Locator');
  const expected = labelled(text, 'Expected');
  const received = labelled(text, 'Received');
  const timeoutText = /^\s*Timeout:[ \t]*(\d+)ms\s*$/m.exec(text)?.[1];
  const facts: Omit<ErrorFacts, 'kind'> = {
    matcher,
    locatorCode,
    expected,
    received,
    timeoutMs: timeoutText === undefined ? undefined : Number(timeoutText),
  };
  const kind = (k: ErrorKind): ErrorFacts => ({ kind: k, ...facts });

  // Mobile infrastructure first, for the same reason web crashes come first: a dead session says
  // nothing about the test's own correctness, and its message often still names an element.
  if (MOBILE_INFRA_SIGNS.some(sign => text.includes(sign))) {
    return kind('browser-crash');
  }
  // A capability gap. Checked before the element patterns because its message names an action, and
  // before the fixture check because it is thrown from inside the fixture's own action path — which
  // would otherwise read it as setup breaking rather than as the test asking for the impossible.
  if (MOBILE_UNSUPPORTED_PATTERNS.some(pattern => pattern.test(text))) {
    return kind('driver-unsupported');
  }
  // Found, then gone before the command landed. The tree changed mid-command, which is a race.
  if (text.includes('stale element reference')) {
    return kind('stale-element');
  }
  // Found, but not usable. The locator is correct, so this must never be read as drift.
  if (text.includes('element not interactable') || text.includes('element click intercepted')) {
    return kind('not-interactable');
  }
  // A selector the driver refused outright — the test's own locator is malformed, and no replacement
  // can be proven for a locator that never described anything.
  if (/used with strategy ".*" is invalid!|invalid selector/.test(text)) {
    return kind('value-mismatch');
  }
  // The element was not there. Mapped onto the SAME kind the web path uses, which is what makes the
  // rest of the engine — weights, bands, vetoes, the equivalence gate — work on mobile unchanged.
  if (MOBILE_MISSING_SIGNS.some(sign => text.includes(sign))) {
    return kind('presence-timeout');
  }

  // Environment first: these say nothing about the test's own correctness, so they must not be read
  // as a locator or a value problem just because a matcher happens to appear in the same message.
  if (CRASH_SIGNS.some(sign => text.includes(sign))) {
    return kind('browser-crash');
  }
  if (NETWORK_SIGNS.some(sign => text.includes(sign))) {
    return kind('network');
  }
  // A fixture or hook failure means setup broke and the test body never really ran. The message
  // itself is whatever the author threw, so the *step category* is the only reliable discriminator —
  // verified against the real reporter API, which reports `category: 'fixture'`.
  if (input.failingStepCategory === 'fixture' || input.failingStepCategory === 'hook') {
    return kind('fixture-error');
  }

  // `strict mode violation: locator('.dup') resolved to 2 elements` — arrives prefixed by the action
  // (`locator.click: Error: strict mode violation: …`), so this is a search, not an anchored match.
  const strict = /strict mode violation:\s*(.+?)\s+resolved to (\d+) element/.exec(text);
  if (strict) {
    return { kind: 'strict-mode', ...facts, locatorCode: facts.locatorCode ?? strict[1] };
  }

  // `Test timeout of 1200ms exceeded.` — the whole test ran out of time with nothing more specific.
  if (/Test timeout of \d+ms exceeded/.test(text)) {
    return kind('test-timeout');
  }

  // `TimeoutError: locator.click: Timeout 1500ms exceeded.`
  if (
    /(?:^|\b)(?:locator|frameLocator|page|elementHandle|request|apiRequestContext)\.\w+:\s*Timeout \d+ms exceeded/.test(
      text,
    )
  ) {
    return kind('action-timeout');
  }

  if (matcher !== undefined && VALUE_MATCHERS.has(matcher)) {
    // `toHaveCount` with nothing found is genuinely ambiguous — the element may be gone, or the list
    // may be legitimately empty — so it gets its own kind rather than a confident answer.
    if (matcher === 'toHaveCount' && received === '0') {
      return kind('count-zero');
    }
    // A value matcher that reported both sides has compared them. Without both, it timed out before
    // it could compare, which is a presence problem wearing a value matcher's name.
    if (expected !== undefined && received !== undefined) {
      return kind('value-mismatch');
    }
    return kind(timeoutText === undefined ? 'unknown' : 'presence-timeout');
  }

  if (matcher !== undefined && PRESENCE_MATCHERS.has(matcher)) {
    return kind('presence-timeout');
  }

  // No matcher named, but the message says outright that nothing matched.
  if (/element\(s\) not found|waiting for locator|to be visible/.test(text)) {
    return kind('presence-timeout');
  }

  if (input.status === 'timedOut') {
    return kind('test-timeout');
  }

  return kind('unknown');
}
