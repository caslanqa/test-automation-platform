import type { MaestroNode, MaestroScreen } from './types.js';

/**
 * Query helpers over a `maestro.inspectScreen()` result. These live in the framework so a test never
 * hand-defines a node type or walks the tree itself — call `rowValue(screen, 'Name')` and move on.
 */

/** Every node in the screen tree, depth-first (parents before children). */
export function flattenScreen(screen: MaestroScreen): MaestroNode[] {
  const out: MaestroNode[] = [];
  const stack: MaestroNode[] = [...(screen.elements ?? [])];
  while (stack.length > 0) {
    const node = stack.pop() as MaestroNode;
    out.push(node);
    if (node.c) {
      stack.push(...node.c);
    }
  }
  return out;
}

/** The first node matching `predicate` (depth-first), or `undefined`. */
export function findNode(
  screen: MaestroScreen,
  predicate: (node: MaestroNode) => boolean,
): MaestroNode | undefined {
  return flattenScreen(screen).find(predicate);
}

/**
 * The value shown in the settings row labelled `label` — e.g. `rowValue(screen, 'Name')` → `'iPhone'`
 * on the iOS About page — or `undefined` if not found.
 *
 * Strategies, in order:
 * 1. A row node that carries the label as `a11y` and the value as `val`/`txt` (iOS settings rows).
 * 2. The nearest text to the RIGHT of the label, on the same row (iOS-style separate value cell).
 * 3. The nearest text directly BELOW the label, horizontally overlapping it (Android title/summary).
 */
export function rowValue(screen: MaestroScreen, label: string): string | undefined {
  const nodes = flattenScreen(screen);

  // 1) The label and its value on the same node (iOS settings rows).
  const sameNode = nodes.find(node => node.a11y === label && (node.val || node.txt));
  if (sameNode) {
    return sameNode.val ?? sameNode.txt;
  }

  const labelNode = nodes.find(node => node.a11y === label || node.txt === label);
  const anchor = labelNode && parseBounds(labelNode.b);
  if (!anchor) {
    return undefined;
  }

  // Candidate value elements: any OTHER node that carries text.
  const candidates = nodes
    .map(node => ({ node, box: parseBounds(node.b) }))
    .filter(
      (entry): entry is { node: MaestroNode; box: Bounds } =>
        entry.node !== labelNode && Boolean(entry.node.txt || entry.node.a11y) && entry.box != null,
    );
  const textOf = (node: MaestroNode): string | undefined => node.txt ?? node.a11y;

  // 2) The nearest text to the RIGHT of the label, on the same row.
  const toRight = candidates
    .filter(({ box }) => box.x1 >= anchor.x2 && overlapsVertically(box, anchor))
    .sort((a, b) => a.box.x1 - b.box.x1);
  if (toRight[0]) {
    return textOf(toRight[0].node);
  }

  // 3) The nearest text directly BELOW the label, horizontally overlapping it.
  const below = candidates
    .filter(({ box }) => box.y1 >= anchor.y2 - 2 && overlapsHorizontally(box, anchor))
    .sort((a, b) => a.box.y1 - b.box.y1);
  return below[0] ? textOf(below[0].node) : undefined;
}

interface Bounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Parse Maestro's `[x1,y1][x2,y2]` bounds string. */
function parseBounds(bounds?: string): Bounds | undefined {
  const match = bounds ? /\[(\d+),(\d+)]\[(\d+),(\d+)]/.exec(bounds) : null;
  return match ? { x1: +match[1], y1: +match[2], x2: +match[3], y2: +match[4] } : undefined;
}

/** Whether two boxes overlap on the vertical axis (i.e. sit on the same row). */
function overlapsVertically(a: Bounds, b: Bounds): boolean {
  return a.y1 < b.y2 && b.y1 < a.y2;
}

/** Whether two boxes overlap on the horizontal axis (i.e. sit in the same column). */
function overlapsHorizontally(a: Bounds, b: Bounds): boolean {
  return a.x1 < b.x2 && b.x1 < a.x2;
}
