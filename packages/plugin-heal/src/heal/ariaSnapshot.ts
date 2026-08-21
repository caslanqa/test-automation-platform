/**
 * Parsing the ARIA snapshot Playwright writes on failure.
 *
 * **This is the discovery the whole healing design rests on.** Playwright 1.61 writes an
 * `error-context` attachment for every failure, and inside it is an ARIA snapshot of the page *at the
 * moment the matcher failed* — the same perception the official healer obtains through an MCP
 * `browser_snapshot` call. So candidate generation needs no fixture, no probe run, no second browser
 * and no new dependency: the reporter already records the attachment's path.
 *
 * That matters beyond convenience. The obvious alternative — an auto-fixture that captures the page
 * on teardown — would have to depend on `page`, and an `auto: true` fixture's dependencies are always
 * instantiated, so **every test in every project would launch a browser**, including an API-only
 * project. Reading a file Playwright already wrote costs nothing on a green run.
 *
 * The format, captured from a real 1.61 run:
 *
 * ```yaml
 * - banner:
 *   - navigation "Main":
 *     - link "Home":
 *       - /url: /a
 * - main:
 *   - form "Sign in":
 *     - text: Email
 *     - textbox "Email":
 *       - /placeholder: you@example.com
 *     - button "Log in"
 *   - region "Results":
 *     - list:
 *       - listitem:
 *         - button "Open"
 * ```
 *
 * Four line shapes, all of which appear above: `- role`, `- role "name"`, `- role: text`, and a
 * property line `- /prop: value`. Nesting is two-space indentation, and it is what gives the ancestor
 * chain the equivalence proof needs.
 *
 * What the snapshot cannot give: test ids, classes and DOM paths. That costs nothing here — a drifted
 * locator has lost its identifier by definition, so there is no test id left to propose.
 *
 * @example
 * const tree = parseAriaSnapshot('- main:\n  - button "Log in"\n');
 * flatten(tree)[1].role; // 'button'
 */

export interface AriaNode {
  role: string;
  /** The accessible name, when the snapshot quoted one. */
  name?: string;
  /** Inline text content, from the `- role: text` form. */
  text?: string;
  /** `/url`, `/placeholder`, `/checked` … keyed without the leading slash. */
  props: Record<string, string>;
  children: AriaNode[];
  /** Ancestors, outermost first — the landmark path, computed while parsing. */
  path: AriaNode[];
}

/** Roles that meaningfully scope a region of the page, used for the neighbourhood signal. */
export const LANDMARK_ROLES = new Set([
  'banner',
  'navigation',
  'main',
  'complementary',
  'contentinfo',
  'region',
  'form',
  'search',
  'dialog',
  'alertdialog',
  'table',
  'list',
  'listitem',
  'row',
  'tabpanel',
  'article',
  'group',
]);

interface RawLine {
  indent: number;
  body: string;
}

function lines(source: string): RawLine[] {
  const out: RawLine[] = [];
  for (const raw of source.split('\n')) {
    const trimmed = raw.trimEnd();
    if (trimmed.trim() === '') {
      continue;
    }
    const withoutIndent = trimmed.replace(/^\s+/, '');
    if (!withoutIndent.startsWith('- ') && withoutIndent !== '-') {
      // A continuation of a wrapped value; the snapshot does not produce these, and guessing at one
      // would invent structure. Skip it rather than mis-nest everything after it.
      continue;
    }
    out.push({
      indent: trimmed.length - withoutIndent.length,
      body: withoutIndent.slice(1).trim(),
    });
  }
  return out;
}

/** `button "Log in"`, `paragraph: Welcome, Ada`, `text: Email`, `/url: /a`. */
function parseBody(body: string): {
  role: string;
  name?: string;
  text?: string;
  prop?: [string, string];
} {
  if (body.startsWith('/')) {
    const colon = body.indexOf(':');
    const key = (colon === -1 ? body : body.slice(0, colon)).slice(1).trim();
    return { role: '', prop: [key, colon === -1 ? '' : body.slice(colon + 1).trim()] };
  }

  // A quoted accessible name may itself contain a colon, so the name is taken before any split.
  const quoted = /^([\w-]+)\s+"((?:[^"\\]|\\.)*)"\s*:?\s*(.*)$/.exec(body);
  if (quoted) {
    const [, role, name, rest] = quoted;
    return {
      role,
      name: name.replace(/\\(.)/g, '$1'),
      text: rest.trim() === '' ? undefined : rest.trim(),
    };
  }

  const colon = body.indexOf(':');
  if (colon === -1) {
    return { role: body.trim() };
  }
  const value = body.slice(colon + 1).trim();
  return { role: body.slice(0, colon).trim(), text: value === '' ? undefined : value };
}

/** Parse a snapshot into a forest. Malformed input yields whatever was readable, never a throw. */
export function parseAriaSnapshot(source: string): AriaNode[] {
  const roots: AriaNode[] = [];
  // Each entry is the node that owns the given indentation level.
  const stack: Array<{ indent: number; node: AriaNode }> = [];

  for (const { indent, body } of lines(source)) {
    const parsed = parseBody(body);

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1]?.node;

    if (parsed.prop !== undefined) {
      // A property belongs to the node above it, not to the tree.
      if (parent !== undefined) {
        parent.props[parsed.prop[0]] = parsed.prop[1];
      }
      continue;
    }

    const node: AriaNode = {
      role: parsed.role,
      name: parsed.name,
      text: parsed.text,
      props: {},
      children: [],
      path: parent === undefined ? [] : [...parent.path, parent],
    };
    if (parent === undefined) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
    stack.push({ indent, node });
  }
  return roots;
}

/** Every node, depth-first, in document order. */
export function flatten(nodes: readonly AriaNode[]): AriaNode[] {
  const out: AriaNode[] = [];
  const walk = (list: readonly AriaNode[]): void => {
    for (const node of list) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** The ancestor chain filtered to landmark roles — the neighbourhood an element sits in. */
export const landmarkPath = (node: AriaNode): string[] =>
  node.path
    .filter(ancestor => LANDMARK_ROLES.has(ancestor.role))
    .map(ancestor =>
      ancestor.name === undefined ? ancestor.role : `${ancestor.role} "${ancestor.name}"`,
    );

/**
 * Extract the snapshot from an `error-context` attachment. The file is Markdown with the snapshot in a
 * ```yaml fence; when several are present the last one is the page state closest to the failure.
 */
export function snapshotFromErrorContext(markdown: string): string | undefined {
  const blocks = [...markdown.matchAll(/```yaml\n([\s\S]*?)```/g)].map(match => match[1]);
  return blocks.length === 0 ? undefined : blocks[blocks.length - 1];
}
