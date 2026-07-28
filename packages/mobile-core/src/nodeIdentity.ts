/**
 * Gives hierarchy nodes an identity that survives the next read (ADR-007). Each read produces a fresh
 * object graph, so the accessibility tree's `===` comparison silently deselected the user's node on every
 * poll. The key combines position with the node's own identifiers: position alone breaks when a list
 * scrolls, identifiers alone are not unique.
 *
 * @example const tree = assignNodeIdentity(await session.inspectHierarchy());
 */
import type { MobileNode } from './types.js';

const FIELD = '|';

function keyFor(path: string, node: MobileNode): string {
  return [
    path,
    node.className ?? '',
    node.resourceId ?? '',
    node.accessibilityId ?? '',
    // Text is the weakest identifier, so it only distinguishes otherwise-unlabelled siblings.
    node.resourceId || node.accessibilityId ? '' : (node.text ?? ''),
  ].join(FIELD);
}

/** A copy of `nodes` with `path`/`key` assigned. Pure: an adapter may hand back a cached tree. */
export function assignNodeIdentity(nodes: MobileNode[]): MobileNode[] {
  const walk = (node: MobileNode, path: string): MobileNode => ({
    ...node,
    path,
    key: keyFor(path, node),
    children: node.children?.map((child, index) => walk(child, `${path}/${index}`)),
  });
  return nodes.map((node, index) => walk(node, String(index)));
}

/** Depth-first lookup by `key`, for re-resolving a remembered node against the current tree. */
export function findNodeByKey(nodes: MobileNode[], key: string): MobileNode | undefined {
  for (const node of nodes) {
    if (node.key === key) {
      return node;
    }
    const inChildren = findNodeByKey(node.children ?? [], key);
    if (inChildren) {
      return inChildren;
    }
  }
  return undefined;
}
