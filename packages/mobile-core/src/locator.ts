/**
 * Shared helpers for matching a driver-neutral {@link MobileLocator} against a normalized
 * {@link MobileNode} tree, and for turning a matched node's bounds into a tappable point. Used by
 * both adapters (Phase 2) for gestures that need pixel coordinates (`drag`, `pinch`), and will be
 * reused by the locator ranking engine (Phase 4).
 */
import type { LocatorCandidate, MobileLocator, MobileNode, MobileTarget } from './types.js';

/**
 * Depth-first search for the node matching `locator`'s set fields (all must match), honouring
 * `locator.index` — which selects among the matches rather than narrowing what counts as one.
 *
 * Stops at the wanted match rather than collecting every one of them. Building the full list first reads more
 * simply and turns every lookup — `resolveTargetPoint` does one per `drag`/`pinch` endpoint — into a complete
 * walk of a tree that can hold thousands of nodes, for a match that is usually the first hit.
 * {@link countMatches} genuinely needs the whole list; this does not.
 */
export function findNode(nodes: MobileNode[], locator: MobileLocator): MobileNode | undefined {
  const wanted = locator.index ?? 0;
  let seen = -1;
  const visit = (candidates: MobileNode[]): MobileNode | undefined => {
    for (const node of candidates) {
      if (nodeMatches(node, locator)) {
        seen += 1;
        if (seen === wanted) {
          return node;
        }
      }
      const inChildren = node.children?.length ? visit(node.children) : undefined;
      if (inChildren) {
        return inChildren;
      }
    }
    return undefined;
  };
  return visit(nodes);
}

/** Every node matching `locator`, in depth-first order — the order `index` counts in. */
function matchingNodes(nodes: MobileNode[], locator: MobileLocator): MobileNode[] {
  const matches: MobileNode[] = [];
  const visit = (candidates: MobileNode[]): void => {
    for (const node of candidates) {
      if (nodeMatches(node, locator)) {
        matches.push(node);
      }
      if (node.children?.length) {
        visit(node.children);
      }
    }
  };
  visit(nodes);
  return matches;
}

function nodeMatches(node: MobileNode, locator: MobileLocator): boolean {
  let matchedAny = false;
  if (locator.accessibilityId !== undefined) {
    if (node.accessibilityId !== locator.accessibilityId) {
      return false;
    }
    matchedAny = true;
  }
  if (locator.resourceId !== undefined) {
    if (node.resourceId !== locator.resourceId) {
      return false;
    }
    matchedAny = true;
  }
  if (locator.text !== undefined) {
    if (node.text !== locator.text) {
      return false;
    }
    matchedAny = true;
  }
  return matchedAny;
}

/** The center point of a node's bounds, or `undefined` when the node has no bounds. */
export function centerOf(node: MobileNode): { x: number; y: number } | undefined {
  if (!node.bounds) {
    return undefined;
  }
  return {
    x: Math.round(node.bounds.x + node.bounds.width / 2),
    y: Math.round(node.bounds.y + node.bounds.height / 2),
  };
}

/**
 * Resolve a {@link MobileTarget} (a locator or explicit `{ x, y }`) to a pixel point, searching
 * `hierarchy` when it's a locator. Throws when a locator target can't be found or has no bounds.
 */
export function resolveTargetPoint(
  target: MobileTarget,
  hierarchy: MobileNode[],
): { x: number; y: number } {
  if ('x' in target && 'y' in target) {
    return target;
  }
  const node = findNode(hierarchy, target);
  if (!node) {
    throw new Error(`[mobile-inspector] no element matched locator ${JSON.stringify(target)}`);
  }
  const center = centerOf(node);
  if (!center) {
    throw new Error(
      `[mobile-inspector] matched element has no bounds for locator ${JSON.stringify(target)}`,
    );
  }
  return center;
}

function containsPoint(node: MobileNode, x: number, y: number): boolean {
  const b = node.bounds;
  return !!b && x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
}

function area(node: MobileNode): number {
  return node.bounds ? node.bounds.width * node.bounds.height : Infinity;
}

function hasStableLocator(node: MobileNode): boolean {
  return !!(node.accessibilityId || node.resourceId || node.text);
}

/**
 * Find the smallest stable-locatable node whose bounds contain `(x, y)`. Native trees frequently
 * place anonymous implementation children inside an actionable parent (for example an EditText);
 * blindly choosing the smallest node reduces those controls to fragile coordinate locators. Fall
 * back to the smallest anonymous node only when no containing node has id/text/a11y metadata.
 */
export function hitTest(hierarchy: MobileNode[], x: number, y: number): MobileNode | undefined {
  let smallest: MobileNode | undefined;
  let smallestStable: MobileNode | undefined;
  const visit = (nodes: MobileNode[]): void => {
    for (const node of nodes) {
      if (containsPoint(node, x, y)) {
        if (!smallest || area(node) < area(smallest)) {
          smallest = node;
        }
        if (hasStableLocator(node) && (!smallestStable || area(node) < area(smallestStable))) {
          smallestStable = node;
        }
      }
      if (node.children?.length) {
        visit(node.children);
      }
    }
  };
  visit(hierarchy);
  return smallestStable ?? smallest;
}

/**
 * Rank a node's identifying attributes into a single best {@link MobileLocator} — accessibility id
 * first (most stable across platforms), then resource id, then visible text, and finally a raw
 * coordinate fallback (flagged fragile via `label`) when the node has none of the above.
 */
export function locatorForNode(node: MobileNode): MobileLocator {
  if (node.accessibilityId) {
    return { accessibilityId: node.accessibilityId, label: node.accessibilityId };
  }
  if (node.resourceId) {
    return { resourceId: node.resourceId, label: node.resourceId };
  }
  if (node.text) {
    return { text: node.text, label: node.text };
  }
  const center = centerOf(node);
  return {
    point: center ?? { x: 0, y: 0 },
    label: '⚠︎ coordinate (fragile — no stable id/text on this element)',
  };
}

/**
 * Warn when a node belongs to a different app than the one under test. The hierarchy is a whole-screen
 * capture, so the status bar and notification shade appear in it, but a driver scoped to one app id cannot
 * act on them — recording one produces a test that passes in the inspector and fails on replay. Returns
 * `undefined` when the platform gave us no package to compare, which is not the same as "in the app".
 *
 * @example outOfAppWarning({ appPackage: 'com.android.systemui' }, 'com.example.app')
 */
export function outOfAppWarning(node: MobileNode, appId?: string): string | undefined {
  if (!appId || !node.appPackage || node.appPackage === appId) {
    return undefined;
  }
  return `belongs to ${node.appPackage}, not the app under test (${appId}) — the driver is scoped to the app, so this will not resolve on replay`;
}

/**
 * Count how many nodes in `hierarchy` match `locator` — used to flag non-unique candidates.
 *
 * `locator.index` is not part of the match: it picks one of the results, so counting with it applied would
 * report every `index`-bearing locator as unique and defeat the check.
 */
export function countMatches(hierarchy: MobileNode[], locator: MobileLocator): number {
  return matchingNodes(hierarchy, locator).length;
}

/** Render a `MobileLocator` as a copy-ready TypeScript object literal (matches the codegen style). */
function locatorDisplay(locator: MobileLocator): string {
  const index = locator.index === undefined ? '' : `, index: ${locator.index}`;
  if (locator.accessibilityId !== undefined) {
    return `{ accessibilityId: ${JSON.stringify(locator.accessibilityId)}${index} }`;
  }
  if (locator.resourceId !== undefined) {
    return `{ resourceId: ${JSON.stringify(locator.resourceId)}${index} }`;
  }
  if (locator.text !== undefined) {
    return `{ text: ${JSON.stringify(locator.text)}${index} }`;
  }
  if (locator.point !== undefined) {
    return `{ point: { x: ${locator.point.x}, y: ${locator.point.y} } }`;
  }
  return '{}';
}

function confidenceBand(score: number): 'high' | 'medium' | 'low' {
  if (score >= 75) {
    return 'high';
  }
  return score >= 45 ? 'medium' : 'low';
}

/**
 * Produce every valid, ranked {@link LocatorCandidate} for `node`, best-first. Scoring is
 * deterministic and mirrors `plan.md`'s stability order — accessibility id (most portable) down to a
 * raw coordinate fallback (always last, always flagged fragile). Each candidate's uniqueness is
 * evaluated against the whole `hierarchy`; a non-unique id/text loses points and gains a warning, so
 * the UI can explain why an otherwise-strong locator is risky. Ties break by the fixed strategy
 * order below, so the output is stable across runs.
 */
export function locatorCandidates(
  node: MobileNode,
  hierarchy: MobileNode[],
  options: { appId?: string } = {},
): LocatorCandidate[] {
  const candidates: LocatorCandidate[] = [];
  const outOfApp = outOfAppWarning(node, options.appId);

  const add = (
    strategy: LocatorCandidate['strategy'],
    locator: MobileLocator,
    baseScore: number,
    baseWarnings: string[] = [],
  ): void => {
    const warnings = [...baseWarnings];
    let score = baseScore;
    if (outOfApp) {
      // Heavier than the non-unique penalty: a locator outside the app under test does not merely risk
      // matching the wrong element, it cannot resolve at all when the test replays.
      score -= 60;
      warnings.push(outOfApp);
    }
    // Coordinate candidates aren't "matchable" against the tree; everything else is uniqueness-checked.
    const matches = strategy === 'point' ? [] : matchingNodes(hierarchy, locator);
    const unique = strategy !== 'point' && matches.length === 1;
    if (strategy !== 'point' && !unique) {
      score -= 25;
      warnings.push('not unique — multiple elements match this locator');
    }
    score = Math.max(0, Math.min(100, score));
    candidates.push({
      strategy,
      locator,
      score,
      confidence: confidenceBand(score),
      unique,
      warnings,
      display: locatorDisplay(locator),
    });

    // A repeated list row leaves every attribute non-unique, and the only candidate that used to survive
    // that was a raw coordinate — so recording an ordinary "third item in the list" produced a fragile step.
    // Pinning the ordinal keeps the attribute and disambiguates it; it is offered BELOW the plain candidate
    // (which may still be the right answer once the list is filtered) and above the coordinate, and it says
    // what makes it fragile rather than presenting itself as solid.
    const ordinal = matches.indexOf(node);
    if (!unique && ordinal >= 0) {
      const indexed = { ...locator, index: ordinal };
      candidates.push({
        strategy,
        locator: indexed,
        score: Math.max(0, Math.min(100, baseScore - (outOfApp ? 60 : 0) - 10)),
        confidence: confidenceBand(Math.max(0, baseScore - (outOfApp ? 60 : 0) - 10)),
        // Exactly one element by construction: it selects among the matches rather than describing them.
        unique: true,
        warnings: [
          ...warnings.filter(warning => !warning.startsWith('not unique')),
          `position-dependent — matches ${matches.length} elements and takes number ${ordinal + 1}, so ` +
            'reordering or filtering the list changes what this resolves to',
        ],
        display: locatorDisplay(indexed),
      });
    }
  };

  if (node.accessibilityId) {
    add('accessibilityId', { accessibilityId: node.accessibilityId }, 92);
  }
  if (node.resourceId) {
    add('resourceId', { resourceId: node.resourceId }, 80);
  }
  if (node.text) {
    const warnings = node.text.length > 40 ? ['long text — may be dynamic/localized'] : [];
    add('text', { text: node.text }, 58, warnings);
  }
  const center = centerOf(node);
  if (center) {
    add('point', { point: center }, 12, [
      'coordinate fallback — fragile; breaks on layout/resolution changes',
    ]);
  }

  return candidates.sort((a, b) => b.score - a.score);
}
