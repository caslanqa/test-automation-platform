/**
 * The capability predicate that decides whether a definition is rendered at all. Claude Code has no
 * conditional component loading — a plugin is enabled or disabled whole — so this is where "no
 * mobile plugin installed, no mobile agent" is actually enforced.
 *
 * Grammar, kept small on purpose: comma or array = AND, `|` inside one term = OR, a leading `!`
 * negates. No parentheses, no precedence, no parser generator.
 *
 * Tokens are `core` (always true), `plugin:<manifest.id>` and `cap:<name>`. A token of an
 * unrecognised *shape* is a typo in a definition file; it evaluates false and warns, and the
 * negation is ignored so a misspelling fails closed rather than silently switching a component on.
 *
 * @example
 * evaluateRequires(parseRequires('plugin:appium | plugin:maestro'), new Set(['core', 'plugin:appium']));
 * // true
 */

/** AND of ORs. Each inner array is one term's alternatives. */
export type RequiresTerms = Array<Array<{ token: string; negated: boolean }>>;

const KNOWN_PREFIXES = ['plugin:', 'cap:'];

/** True when `token` is one of the three recognised shapes. */
export function isKnownToken(token: string): boolean {
  if (token === 'core') {
    return true;
  }
  return KNOWN_PREFIXES.some(prefix => token.startsWith(prefix) && token.length > prefix.length);
}

/**
 * Normalise the authored `requires` value. Absent, empty, or an empty list all mean `core`, so a
 * definition that says nothing is rendered everywhere.
 */
export function parseRequires(raw: string | string[] | undefined): RequiresTerms {
  const rawTerms = (Array.isArray(raw) ? raw : (raw ?? '').split(','))
    .flatMap(part => part.split(','))
    .map(part => part.trim())
    .filter(part => part !== '');
  if (rawTerms.length === 0) {
    return [[{ token: 'core', negated: false }]];
  }
  return rawTerms.map(term =>
    term
      .split('|')
      .map(alt => alt.trim())
      .filter(alt => alt !== '')
      .map(alt =>
        alt.startsWith('!')
          ? { token: alt.slice(1).trim(), negated: true }
          : { token: alt, negated: false },
      ),
  );
}

export function evaluateRequires(
  terms: RequiresTerms,
  tokens: ReadonlySet<string>,
  onUnknown?: (token: string) => void,
): boolean {
  return terms.every(alternatives =>
    alternatives.some(({ token, negated }) => {
      if (!isKnownToken(token)) {
        onUnknown?.(token);
        // Fail closed: a typo must not enable a component through its own negation.
        return false;
      }
      const present = token === 'core' || tokens.has(token);
      return negated ? !present : present;
    }),
  );
}
