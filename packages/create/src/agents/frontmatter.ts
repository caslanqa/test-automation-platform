/**
 * The flat YAML subset used by agent/skill/command definition files. Deliberately not a YAML
 * parser: the definitions in `agents/` only ever need scalars, inline lists and block lists, and
 * taking a `yaml` dependency would show up in every `nfr-check.mjs` run for the rest of the repo's
 * life. Read and write pay for each other — the Claude renderer emits `SKILL.md` and agent files
 * that need frontmatter back out, so the serializer is not overhead.
 *
 * The body is returned byte-for-byte, including CRLF, because it is prose a human wrote and the
 * renderer must not silently reformat it.
 *
 * @example
 * const { data, body } = parseFrontmatter('---\nname: vv-lead\n---\nYou route…\n', 'vv-lead.md');
 * data.name; // 'vv-lead'
 */

export type FrontmatterValue = string | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

export interface ParsedDoc {
  data: Frontmatter;
  /** Everything after the closing `---` line, verbatim. */
  body: string;
}

export class FrontmatterError extends Error {
  readonly file: string;

  constructor(file: string, problem: string) {
    super(`[pwtap] ${file}: ${problem}`);
    this.name = 'FrontmatterError';
    this.file = file;
  }
}

/** YAML scalars that would parse as a non-string, so they must be quoted on the way out. */
const RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~', '']);

const isDelimiter = (line: string): boolean => line.trimEnd() === '---';

/** Drop a single trailing CR so a CRLF file parses identically to an LF one. */
const withoutCr = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line);

/**
 * Unquote one scalar. Double-quoted values go through `JSON.parse` so escapes are handled by the
 * runtime rather than by a hand-rolled state machine; single quotes are the YAML form where the
 * only escape is a doubled quote.
 */
function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** `[a, b]` → `['a', 'b']`. An empty `[]` yields `[]`. */
function parseInlineList(raw: string): string[] {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner === '') {
    return [];
  }
  return inner
    .split(',')
    .map(unquote)
    .filter(item => item !== '');
}

export function parseFrontmatter(source: string, file: string): ParsedDoc {
  const lines = source.split('\n');
  if (!isDelimiter(withoutCr(lines[0] ?? ''))) {
    throw new FrontmatterError(file, 'missing opening `---`');
  }
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (isDelimiter(withoutCr(lines[i]))) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    throw new FrontmatterError(file, 'missing closing `---`');
  }

  const data: Frontmatter = {};
  let lastKey: string | undefined;
  for (const rawLine of lines.slice(1, end)) {
    const line = withoutCr(rawLine);
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    if (trimmed.startsWith('- ') || trimmed === '-') {
      if (lastKey === undefined) {
        throw new FrontmatterError(file, `list item before any key: ${trimmed}`);
      }
      const existing = data[lastKey];
      const item = unquote(trimmed.slice(1));
      data[lastKey] = Array.isArray(existing) ? [...existing, item] : [item];
      continue;
    }
    const colon = line.indexOf(':');
    if (colon === -1) {
      throw new FrontmatterError(file, `expected 'key: value' but found: ${trimmed}`);
    }
    const key = line.slice(0, colon).trim();
    if (key === '') {
      throw new FrontmatterError(file, `empty key in: ${trimmed}`);
    }
    const rest = line.slice(colon + 1).trim();
    lastKey = key;
    if (rest === '') {
      // Either a block list follows, or the key is genuinely empty. `[]` is the honest starting
      // value: a following `- item` appends to it, and nothing following leaves an empty list.
      data[key] = [];
      continue;
    }
    data[key] = rest.startsWith('[') && rest.endsWith(']') ? parseInlineList(rest) : unquote(rest);
  }

  // Byte offsets, not a re-join of the parsed lines: the body must survive verbatim.
  const consumed = lines.slice(0, end + 1).join('\n').length + 1;
  return { data, body: consumed <= source.length ? source.slice(consumed) : '' };
}

/** True when emitting `value` bare would change what a YAML reader sees. */
function needsQuoting(value: string): boolean {
  if (RESERVED.has(value.toLowerCase())) {
    return true;
  }
  if (value !== value.trim()) {
    return true;
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return true;
  }
  // A leading indicator character, or any of `:`/`#`/`,`/brackets/braces anywhere. `:` and `#` are
  // quoted even mid-string so a stricter reader than ours still sees one scalar.
  return !/^[A-Za-z0-9(][^:#,[\]{}\n]*$/.test(value);
}

const emit = (value: string): string => (needsQuoting(value) ? JSON.stringify(value) : value);

/**
 * Render frontmatter + body. Lists are always inline arrays — one line per key keeps a rendered
 * definition diffable against the source it came from.
 */
export function serializeFrontmatter(data: Frontmatter, body: string): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(data)) {
    lines.push(
      Array.isArray(value) ? `${key}: [${value.map(emit).join(', ')}]` : `${key}: ${emit(value)}`,
    );
  }
  lines.push('---', '');
  return lines.join('\n') + body;
}
