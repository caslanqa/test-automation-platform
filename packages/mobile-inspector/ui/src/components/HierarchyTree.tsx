import { useMemo, useState } from 'react';

import type { MobileNode } from '../protocol';

interface HierarchyTreeProps {
  nodes: MobileNode[];
  /** Identity of the selected node, never the object: a poll replaces every node (ADR-007). */
  selectedKey: string | null;
  onSelect: (key: string) => void;
}

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
          <TreeNode key={n.key ?? i} node={n} selectedKey={selectedKey} onSelect={onSelect} />
        ))}
        {visible.length === 0 && <li className="muted">no elements</li>}
      </ul>
    </div>
  );
}

function TreeNode({
  node,
  selectedKey,
  onSelect,
}: {
  node: MobileNode;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = !!node.children?.length;

  return (
    <li>
      <div className="tree-row">
        {hasChildren && (
          <button className="tree-toggle" onClick={() => setExpanded(!expanded)}>
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
      </div>
      {hasChildren && expanded && (
        <ul>
          {(node.children ?? []).map((c, i) => (
            <TreeNode key={c.key ?? i} node={c} selectedKey={selectedKey} onSelect={onSelect} />
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
