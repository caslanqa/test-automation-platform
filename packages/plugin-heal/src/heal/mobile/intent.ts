/**
 * What a mobile locator states, read out of the spec's own source.
 *
 * The web path gets this for free: Playwright prints `Locator: getByRole('button', { name: 'Log in' })`
 * in the failure message. A mobile failure has no such line — the message is
 * `[mobile-inspector] "tap" failed: <driver error>` and the driver error names the selector in its own
 * words, if at all. What it does have is a stack frame pointing at the line that made the call, which is
 * also the line an edit would change. So the intent is parsed from there.
 *
 * A deliberately small parser, not an AST. The thing being read is a `MobileLocator` object literal —
 * `{ accessibilityId: 'loginButton' }`, `{ text: 'Log in', index: 2 }` — with string, number and boolean
 * fields and no nesting. Pulling in a TypeScript parser to read five keys would cost this package its
 * zero-dependency budget for no accuracy it does not already have; anything the parser cannot read
 * returns undefined, which refuses the repair rather than guessing at it.
 *
 * @example
 * parseMobileIntent("  await mobileApp.tap({ accessibilityId: 'loginButton' });");
 * // → { locator: { accessibilityId: 'loginButton' }, signals: ['accessibilityId'], … }
 */
import type { MobileLocatorLike } from './types.js';

export interface MobileIntent {
  /** The literal exactly as it appears in the source, for a byte-accurate replacement. */
  code: string;
  /** Where in the line the literal starts and ends, so the edit touches nothing else. */
  start: number;
  end: number;
  locator: MobileLocatorLike;
  /** Which identifying fields the locator states. Two is the bar for a proof, as on the web. */
  signals: Array<'accessibilityId' | 'resourceId' | 'text'>;
  /** The action the line performs, when the line is an action call. Reported, never acted on. */
  action?: string;
  /** True when the locator states only a coordinate — nothing to identify, nothing to repair. */
  coordinateOnly: boolean;
}

/** Only the fields a repair may read or write. `native` is deliberately absent — see `readLiteral`. */
const KNOWN_KEYS = new Set(['accessibilityId', 'resourceId', 'text', 'index', 'x', 'y', 'native']);

/** The balanced object literal starting at `open`, or undefined when it is not one. */
function balanced(line: string, open: number): { text: string; end: number } | undefined {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = open; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return { text: line.slice(open, index + 1), end: index + 1 };
      }
    }
  }
  return undefined;
}

/**
 * Read `{ key: value, … }` into an object.
 *
 * Returns undefined rather than a partial result when it meets anything it does not understand — a
 * template literal, a variable, a nested object, a spread, a `native` escape hatch. A locator this
 * cannot fully read is a locator a repair must not rewrite, because the part it could not read may be
 * the part that identifies the element.
 */
export function readLiteral(text: string): MobileLocatorLike | undefined {
  const inner = text.trim();
  if (!inner.startsWith('{') || !inner.endsWith('}')) {
    return undefined;
  }
  const body = inner.slice(1, -1).trim();
  if (body === '') {
    return {};
  }

  const out: Record<string, string | number | boolean> = {};
  // Fields are flat, so splitting on top-level commas is enough — and quotes are respected so a comma
  // inside a label does not end a field.
  const fields: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '{' || char === '[' || char === '(') {
      depth += 1;
    } else if (char === '}' || char === ']' || char === ')') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      fields.push(body.slice(start, index));
      start = index + 1;
    }
  }
  fields.push(body.slice(start));

  for (const field of fields) {
    const trimmed = field.trim();
    if (trimmed === '') {
      continue;
    }
    const colon = trimmed.indexOf(':');
    if (colon === -1) {
      // Shorthand (`{ text }`) names a variable, whose value is not in this line.
      return undefined;
    }
    const key = trimmed
      .slice(0, colon)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    const value = trimmed.slice(colon + 1).trim();
    if (!KNOWN_KEYS.has(key) || key === 'native') {
      // `native` is a driver-specific escape hatch that nothing generates and nothing may rewrite.
      return undefined;
    }
    if (/^'([^'\\]|\\.)*'$/.test(value) || /^"([^"\\]|\\.)*"$/.test(value)) {
      out[key] = value.slice(1, -1).replace(/\\(.)/g, '$1');
    } else if (/^-?\d+(\.\d+)?$/.test(value)) {
      out[key] = Number(value);
    } else if (value === 'true' || value === 'false') {
      out[key] = value === 'true';
    } else {
      // A template literal, a variable, an expression: not readable from this line alone.
      return undefined;
    }
  }
  return out as MobileLocatorLike;
}

/** `await mobileApp.tap({ … })` → the action name, when the line is one. */
const ACTION =
  /\.\s*(tap|doubleTap|longPress|fill|clear|swipe|scrollTo|waitFor|assertVisible|press)\s*\(/;

/**
 * Parse the locator literal out of one source line.
 *
 * Takes the **first** object literal after an action call, which is where a `MobileLocator` sits in
 * every shape this platform generates or documents.
 */
export function parseMobileIntent(line: string): MobileIntent | undefined {
  const action = ACTION.exec(line);
  const searchFrom = action === null ? 0 : action.index + action[0].length;
  const open = line.indexOf('{', searchFrom);
  if (open === -1) {
    return undefined;
  }
  const literal = balanced(line, open);
  if (literal === undefined) {
    return undefined;
  }
  const locator = readLiteral(literal.text);
  if (locator === undefined) {
    return undefined;
  }

  const signals: MobileIntent['signals'] = [];
  if (typeof locator.accessibilityId === 'string') signals.push('accessibilityId');
  if (typeof locator.resourceId === 'string') signals.push('resourceId');
  if (typeof locator.text === 'string') signals.push('text');

  return {
    code: literal.text,
    start: open,
    end: literal.end,
    locator,
    signals,
    action: action?.[1],
    coordinateOnly: signals.length === 0 && (locator.x !== undefined || locator.y !== undefined),
  };
}
