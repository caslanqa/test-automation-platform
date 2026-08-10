import { useMemo, useState } from 'react';

import type { MobileNode } from '../protocol';

interface HierarchyTreeProps {
  nodes: MobileNode[];
  /** Identity of the selected node, never the object: a poll replaces every node (ADR-007). */
  selectedKey: string | null;
  onSelect: (key: string) => void;
}

/**
 * How deep the tree comes up expanded.
 *
 * Every node used to start expanded, so a native screen rendered its entire hierarchy — commonly several
 * hundred rows, most of them anonymous layout containers nobody reads — and paid for all of it on every
 * hierarchy update. Three levels is enough to see the structure and pick a branch; the rest is one click away.
 */
const DEFAULT_EXPANDED_DEPTH = 3;

/**
 * Recursive accessibility-tree viewer with a text filter. Clicking a node selects it, which
 * highlights its bounds on the device image (bidirectional selection sync).
 */
export function HierarchyTree({ nodes, selectedKey, onSelect }: HierarchyTreeProps) {
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();

  const visible = useMemo(
    () => (q ? nodes.map(n => pruneTree(n, q)).filter(Boolean) : nodes),
    [nodes, q],
  ) as MobileNode[];

  return (
    <div className="hierarchy-tree">
      <div className="panel-title">Accessibility tree</div>
      <input
        className="tree-filter"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        placeholder="filter nodes…"
      />
      <ul>
        {visible.map((n, i) => (
          <TreeNode
            key={n.key ?? i}
            node={n}
            depth={0}
            selectedKey={selectedKey}
            onSelect={onSelect}
            // A filtered tree is already only matches and their ancestors, so the depth default would hide
            // the very rows the user searched for.
            forceExpanded={q.length > 0}
          />
        ))}
        {visible.length === 0 && <li className="muted">no elements</li>}
      </ul>
    </div>
  );
}

function TreeNode({
  node,
  depth,
  selectedKey,
  onSelect,
  forceExpanded,
}: {
  node: MobileNode;
  depth: number;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  forceExpanded: boolean;
}) {
  // Per-node state, keyed by React on the node's own `key` (ADR-007), so a hierarchy update that leaves a
  // node in place leaves its expansion alone. The initial value is only read on mount, which is exactly
  // where the depth default belongs.
  const [collapsedOverride, setCollapsedOverride] = useState(depth >= DEFAULT_EXPANDED_DEPTH);
  const expanded = forceExpanded || !collapsedOverride;
  const childCount = node.children?.length ?? 0;

  return (
    <li>
      <div className="tree-row">
        {childCount > 0 && (
          <button
            className="tree-toggle"
            onClick={() => setCollapsedOverride(expanded)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse' : `Expand ${childCount} children`}
          >
            {expanded ? '▾' : '▸'}
          </button>
        )}
        <span
          className={`tree-label${node.key && node.key === selectedKey ? ' selected' : ''}`}
          onClick={() => node.key && onSelect(node.key)}
          title="click to select"
        >
          {labelFor(node)}
        </span>
        {/* A collapsed branch has to say it is hiding something, or a depth default reads as a missing tree. */}
        {childCount > 0 && !expanded && <span className="muted tree-count">{childCount}</span>}
      </div>
      {childCount > 0 && expanded && (
        <ul>
          {(node.children ?? []).map((c, i) => (
            <TreeNode
              key={c.key ?? i}
              node={c}
              depth={depth + 1}
              selectedKey={selectedKey}
              onSelect={onSelect}
              forceExpanded={forceExpanded}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function labelFor(node: MobileNode): string {
  const parts = [node.className ?? 'node'];
  if (node.text) parts.push(`"${node.text}"`);
  if (node.accessibilityId) parts.push(`a11y=${node.accessibilityId}`);
  if (node.resourceId) parts.push(`id=${node.resourceId}`);
  return parts.join(' ');
}

/** Keep a node if it (or any descendant) matches the filter; returns a pruned copy or null. */
function pruneTree(node: MobileNode, q: string): MobileNode | null {
  const selfMatch = labelFor(node).toLowerCase().includes(q);
  const children = (node.children ?? [])
    .map(c => pruneTree(c, q))
    .filter((c): c is MobileNode => c !== null);
  if (selfMatch || children.length > 0) {
    return { ...node, children };
  }
  return null;
}
