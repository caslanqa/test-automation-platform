/**
 * ANSI stripping and message normalisation.
 *
 * Stripping is **load-bearing, not cosmetic**: Playwright's matcher formatter wraps `Expected:` and
 * `Received:` in colour, so the same failure produces different bytes under a TTY than in CI. An
 * un-stripped message therefore fingerprints differently depending on where it ran, which would
 * silently split every cluster in two. Playwright's own `stripAnsiEscapes` is internal, so this is
 * four lines of ours rather than a dependency.
 *
 * @example
 * normalizeMessage('Error: expect(locator).toHaveText(expected) failed\n\nExpected: "a"\nTimeout:  1500ms\nCall log:\n  - x');
 * // → 'Error: expect(locator).toHaveText(expected) failed Expected: "a"'
 */

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export const stripAnsi = (text: string): string => text.replace(ANSI, '');

/** Cap on a normalised message, so a record never carries a page dump. */
const MAX_MESSAGE = 2048;

export interface NormalizeOptions {
  /** Absolute paths are rewritten relative to this, so two machines agree. */
  rootDir?: string;
}

/**
 * Reduce a message to the part that identifies the failure and nothing else.
 *
 * Order matters: the call log goes before number collapsing, because it is the part that carries
 * timestamps and retry counts and would otherwise dominate the hash.
 */
export function normalizeMessage(raw: string, options: NormalizeOptions = {}): string {
  let text = stripAnsi(raw);

  // The call log carries per-attempt timing, so it can never be part of an identity.
  const callLogAt = text.indexOf('\nCall log:');
  if (callLogAt !== -1) {
    text = text.slice(0, callLogAt);
  }

  text = text
    // The timeout is a config value, not a property of the failure.
    .replace(/^\s*Timeout:\s*\d+ms\s*$/gm, '')
    // A code snippet pins the message to a line number, which moves on every edit above it.
    .replace(/^\s*>?\s*\d+\s*\|.*$/gm, '')
    .replace(/^\s*\|\s*\^+\s*$/gm, '');

  if (options.rootDir !== undefined && options.rootDir !== '') {
    text = text
      .split(options.rootDir.endsWith('/') ? options.rootDir : `${options.rootDir}/`)
      .join('');
  }

  return (
    text
      // Any remaining bare number is an instance detail: a count, a port, a coordinate, an ordinal.
      .replace(/\b\d+\b/g, 'N')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_MESSAGE)
  );
}

/** Keep a message readable in a record: ANSI-free, call log removed, capped. */
export function displayMessage(raw: string, max = 4096): string {
  const text = stripAnsi(raw);
  const callLogAt = text.indexOf('\nCall log:');
  return (callLogAt === -1 ? text : text.slice(0, callLogAt)).trim().slice(0, max);
}

/** The first lines of the `Call log:` block, which say what Playwright was waiting for. */
export function callLogLines(raw: string, max = 20): string[] {
  const text = stripAnsi(raw);
  const at = text.indexOf('Call log:');
  if (at === -1) {
    return [];
  }
  return text
    .slice(at + 'Call log:'.length)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .slice(0, max);
}
