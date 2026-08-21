/**
 * What the failing locator was *trying* to identify.
 *
 * The insight that makes the equivalence proof possible without a recorded baseline: **the intent is
 * already written in the code**. `getByRole('button', { name: 'Log in' })` states a role and a name,
 * so a replacement can be checked against both. `locator('#login-button')` states one thing, and that
 * one thing is precisely what vanished — which is why that case is refused rather than guessed at.
 *
 * Counting signals is the whole point. Two independent ones are the bar for a proof; one is not, and
 * saying so is the difference between repointing a locator and pointing at whatever is nearby.
 *
 * @example
 * parseLocatorIntent("getByRole('button', { name: 'Log in' })");
 * // → { role: 'button', name: 'Log in', signals: ['role', 'name'], chain: [...] }
 */

export interface LocatorIntent {
  /** The locator expression as the error message printed it. */
  code: string;
  role?: string;
  /** An accessible name, a label, a placeholder or exact text — whatever named the element. */
  name?: string;
  /** How the name was expressed, which affects how a candidate may match it. */
  nameKind?: 'accessible' | 'label' | 'placeholder' | 'text' | 'title' | 'altText';
  testId?: string;
  cssId?: string;
  /** An explicit ordinal, from `.nth(n)` / `.first()` / `.last()`. */
  ordinal?: number;
  /** Independent identity signals this locator states. Two is the bar for a proof. */
  signals: Array<'role' | 'name' | 'testId'>;
  /** True when the locator is structural — a CSS or XPath selector with nothing semantic in it. */
  structural: boolean;
}

/** Playwright's `getBy*` methods and what each one states about the element. */
const BY_METHODS: Record<string, { nameKind: LocatorIntent['nameKind']; role?: boolean }> = {
  getByRole: { nameKind: 'accessible', role: true },
  getByLabel: { nameKind: 'label' },
  getByPlaceholder: { nameKind: 'placeholder' },
  getByText: { nameKind: 'text' },
  getByTitle: { nameKind: 'title' },
  getByAltText: { nameKind: 'altText' },
};

/** The first string argument of a call, single- or double-quoted. */
const firstArg = (args: string): string | undefined =>
  /^\s*['"`]((?:[^'"`\\]|\\.)*)['"`]/.exec(args)?.[1]?.replace(/\\(.)/g, '$1');

/** `{ name: 'Log in' }` / `{ name: /Log/ }` — a regex name is kept as source, not as a value. */
const namedOption = (args: string): string | undefined =>
  /\bname\s*:\s*['"`]((?:[^'"`\\]|\\.)*)['"`]/.exec(args)?.[1]?.replace(/\\(.)/g, '$1');

export function parseLocatorIntent(code: string): LocatorIntent {
  const intent: LocatorIntent = { code, signals: [], structural: false };

  // Walk every `.method(args)` in the chain, so a scoped locator contributes what it states.
  for (const match of code.matchAll(/(?:^|\.)(\w+)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
    const [, method, args] = match;
    const by = BY_METHODS[method];
    if (by !== undefined) {
      const primary = firstArg(args);
      if (by.role === true) {
        intent.role = primary;
        const name = namedOption(args);
        if (name !== undefined) {
          intent.name = name;
          intent.nameKind = 'accessible';
        }
      } else if (primary !== undefined) {
        intent.name = primary;
        intent.nameKind = by.nameKind;
      }
      continue;
    }
    if (method === 'getByTestId') {
      intent.testId = firstArg(args);
      continue;
    }
    if (method === 'nth') {
      const ordinal = Number(args.trim());
      if (Number.isFinite(ordinal)) {
        intent.ordinal = ordinal;
      }
      continue;
    }
    if (method === 'first') {
      intent.ordinal = 0;
      continue;
    }
    if (method === 'locator' || method === 'css' || method === 'xpath') {
      const selector = firstArg(args);
      if (selector !== undefined) {
        const id = /^#([\w-]+)$/.exec(selector.trim())?.[1];
        if (id !== undefined) {
          intent.cssId = id;
        }
        intent.structural = true;
      }
      continue;
    }
  }

  if (intent.role !== undefined) {
    intent.signals.push('role');
  }
  if (intent.name !== undefined && intent.name !== '') {
    intent.signals.push('name');
  }
  if (intent.testId !== undefined) {
    intent.signals.push('testId');
  }
  // A structural selector that also stated something semantic is not purely structural.
  intent.structural = intent.structural && intent.signals.length === 0;
  return intent;
}
