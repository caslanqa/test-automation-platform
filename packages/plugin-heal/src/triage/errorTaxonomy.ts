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
