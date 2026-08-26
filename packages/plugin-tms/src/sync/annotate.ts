/**
 * Writing the case id back into the spec — the one part of this plugin that edits somebody's source.
 *
 * It is not optional. Qase's own documentation is explicit that the id in code is the only link that
 * survives a rename or a move; matching by suite path and title "sees a 'new' test and the old one's
 * history stops". So the id lives in the spec, committed, in the annotation the vendor reporter already
 * reads at runtime:
 *
 * ```ts
 * test('rejects an expired card', { annotation: { type: 'QaseID', description: '42' } }, async () => {…});
 * ```
 *
 * That means one source of truth and no map file — but it also means this file must never guess. It
 * works from the **exact `line`/`column` the runner reported** for the `test(` call, scans forward with
 * a small string- and comment-aware reader, and **refuses** anything it cannot place with certainty,
 * handing back the snippet for a human to paste. A wrong insertion here is a corrupted spec file; a
 * refusal is a line in a report.
 *
 * Formatting is deliberately left alone: the inserted text is valid and compact on one line, and the
 * project's own prettier is what decides how it should look. Reaching for a formatter here would make
 * one a dependency of every install to save the user a `--write` they already run on commit.
 *
 * @example
 * const result = insertQaseId(source, 3, 7, 42);
 * if (result.ok) fs.writeFileSync(file, result.source);
 * else console.warn(`${file}:3 — ${result.reason}; paste: ${result.snippet}`);
 */

export interface AnnotateResult {
  ok: boolean;
  /** The rewritten file, when `ok`. */
  source?: string;
  /** Why it refused, when not `ok`. Written for a human reading a sync report. */
  reason?: string;
  /** What to paste by hand. Always present, so a refusal is still actionable. */
  snippet: string;
}

/** The annotation entry, rendered. Single quotes because that is what this repo's prettier emits. */
export function qaseIdEntry(id: number): string {
  return `{ type: 'QaseID', description: '${id}' }`;
}

// --- a very small reader -------------------------------------------------------------------------

const WHITESPACE = new Set([' ', '\t', '\r', '\n']);

/** Index of the first character of 1-based `line`, or -1. */
function lineStart(source: string, line: number): number {
  if (line < 1) {
    return -1;
  }
  let index = 0;
  for (let current = 1; current < line; current += 1) {
    const next = source.indexOf('\n', index);
    if (next === -1) {
      return -1;
    }
    index = next + 1;
  }
  return index;
}

/** Skip whitespace and both comment forms, returning the next significant index (or -1 if unterminated). */
function skipTrivia(source: string, from: number): number {
  let index = from;
  for (;;) {
    while (index < source.length && WHITESPACE.has(source[index])) {
      index += 1;
    }
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index);
      if (end === -1) {
        return source.length;
      }
      index = end + 1;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      if (end === -1) {
        return -1;
      }
      index = end + 2;
      continue;
    }
    return index;
  }
}

/**
 * Index just past the string or template literal starting at `from`, or -1.
 *
 * Template literals nest: `` `a ${ `b` } c` `` is one literal containing another, and a reader that
 * stops at the first backtick walks straight into the middle of an expression.
 */
function endOfStringLiteral(source: string, from: number): number {
  const quote = source[from];
  if (quote !== "'" && quote !== '"' && quote !== '`') {
    return -1;
  }
  let index = from + 1;
  let depth = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (quote === '`') {
      if (source.startsWith('${', index)) {
        depth += 1;
        index += 2;
        continue;
      }
      if (char === '}' && depth > 0) {
        depth -= 1;
        index += 1;
        continue;
      }
    }
    if (char === quote && depth === 0) {
      return index + 1;
    }
    index += 1;
  }
  return -1;
}

/**
 * Index of the bracket closing the one at `open`, or -1. Skips strings, template literals and comments,
 * so a `}` inside a title or a `//` comment does not close anything.
 */
function matchBracket(source: string, open: number): number {
  const pairs: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  const closer = pairs[source[open]];
  if (closer === undefined) {
    return -1;
  }
  let depth = 0;
  let index = open;
  while (index < source.length) {
    const char = source[index];
    if (char === "'" || char === '"' || char === '`') {
      const end = endOfStringLiteral(source, index);
      if (end === -1) {
        return -1;
      }
      index = end;
      continue;
    }
    if (source.startsWith('//', index) || source.startsWith('/*', index)) {
      const end = skipTrivia(source, index);
      if (end === -1 || end === index) {
        return -1;
      }
      index = end;
      continue;
    }
    if (char === source[open]) {
      depth += 1;
    } else if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
    index += 1;
  }
  return -1;
}

/** The index of a top-level `annotation` key inside the object spanning `open`..`close`, or -1. */
function findAnnotationKey(source: string, open: number, close: number): number {
  let index = open + 1;
  let depth = 0;
  while (index < close) {
    const char = source[index];
    if (char === "'" || char === '"' || char === '`') {
      const end = endOfStringLiteral(source, index);
      if (end === -1) {
        return -1;
      }
      index = end;
      continue;
    }
    if (char === '{' || char === '[' || char === '(') {
      depth += 1;
    } else if (char === '}' || char === ']' || char === ')') {
      depth -= 1;
    } else if (depth === 0 && source.startsWith('annotation', index)) {
      const before = index === 0 ? ' ' : source[index - 1];
      const after = skipTrivia(source, index + 'annotation'.length);
      if (!/[A-Za-z0-9_$]/.test(before) && after !== -1 && source[after] === ':') {
        return index;
      }
    }
    index += 1;
  }
  return -1;
}

// --- the edit ------------------------------------------------------------------------------------

/** Locate the `(` of the `test(` call the runner pointed at. */
function callParen(source: string, line: number, column: number): number {
  const start = lineStart(source, line);
  if (start === -1) {
    return -1;
  }
  const at = start + column - 1;
  if (source[at] === '(') {
    return at;
  }
  // Tolerate an off-by-one from a future runner version rather than refusing: the `(` is on this line.
  const lineEnd = source.indexOf('\n', start);
  const paren = source.indexOf('(', start);
  return paren !== -1 && (lineEnd === -1 || paren < lineEnd) ? paren : -1;
}

export function insertQaseId(
  source: string,
  line: number,
  column: number,
  id: number,
): AnnotateResult {
  const entry = qaseIdEntry(id);
  const refuse = (reason: string): AnnotateResult => ({
    ok: false,
    reason,
    snippet: `annotation: ${entry}`,
  });

  const paren = callParen(source, line, column);
  if (paren === -1) {
    return refuse(`no test( call found at line ${line}`);
  }

  const titleStart = skipTrivia(source, paren + 1);
  if (titleStart === -1) {
    return refuse('unterminated comment before the test title');
  }
  const titleEnd = endOfStringLiteral(source, titleStart);
  if (titleEnd === -1) {
    return refuse('the test title is not a plain string or template literal');
  }

  const afterTitle = skipTrivia(source, titleEnd);
  if (afterTitle === -1 || source[afterTitle] !== ',') {
    return refuse('the test call has no second argument to attach options to');
  }

  const secondArg = skipTrivia(source, afterTitle + 1);
  if (secondArg === -1) {
    return refuse('unterminated comment after the test title');
  }

  // No options object: `test('title', async () => {…})`. Add one.
  if (source[secondArg] !== '{') {
    return {
      ok: true,
      source: `${source.slice(0, titleEnd)}, { annotation: ${entry} }${source.slice(titleEnd)}`,
      snippet: `annotation: ${entry}`,
    };
  }

  // An options object could also be a `{ … }` arrow body if the title were the only argument — but we
  // only got here through a comma, so this is the options argument.
  const optionsEnd = matchBracket(source, secondArg);
  if (optionsEnd === -1) {
    return refuse('the options object is not balanced');
  }

  const annotationKey = findAnnotationKey(source, secondArg, optionsEnd);
  if (annotationKey === -1) {
    return {
      ok: true,
      source: `${source.slice(0, secondArg + 1)} annotation: ${entry},${source.slice(secondArg + 1)}`,
      snippet: `annotation: ${entry}`,
    };
  }

  const colon = skipTrivia(source, annotationKey + 'annotation'.length);
  const value = skipTrivia(source, colon + 1);
  if (value === -1) {
    return refuse('unterminated comment after the annotation key');
  }

  if (source[value] === '[') {
    const end = matchBracket(source, value);
    if (end === -1) {
      return refuse('the annotation array is not balanced');
    }
    return {
      ok: true,
      source: `${source.slice(0, end)}, ${entry}${source.slice(end)}`,
      snippet: entry,
    };
  }

  if (source[value] === '{') {
    const end = matchBracket(source, value);
    if (end === -1) {
      return refuse('the annotation object is not balanced');
    }
    // One annotation becomes two, so the single object has to become an array.
    return {
      ok: true,
      source: `${source.slice(0, value)}[${source.slice(value, end + 1)}, ${entry}]${source.slice(end + 1)}`,
      snippet: entry,
    };
  }

  return refuse('the annotation value is neither an object nor an array literal');
}
