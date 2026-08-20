/**
 * The shapes this package needs from `@pwtap/mobile-core`, restated.
 *
 * Structural copies rather than imports, because `@pwtap/mobile-core` is an **optional** peer: a web-only
 * project must not have to install a mobile package for the healer's types to resolve. The values come
 * from the real module through a guarded `await import()`; only the shapes live here, and they are
 * narrow enough that a mobile-core minor cannot break them.
 *
 * This is the same trade `mobile-core`'s own locator engine documents in reverse — the web candidate
 * generator copied its scoring policy rather than importing a mobile package into a web runtime.
 */

/** A `MobileLocator`, restricted to the fields a repair may read or write. */
export interface MobileLocatorLike {
  accessibilityId?: string;
  resourceId?: string;
  text?: string;
  index?: number;
  x?: number;
  y?: number;
  native?: unknown;
}

/** One element in a captured hierarchy. */
export interface MobileNodeLike {
  key?: string;
  accessibilityId?: string;
  resourceId?: string;
  text?: string;
  className?: string;
  children?: MobileNodeLike[];
  [extra: string]: unknown;
}

/** What `locatorCandidates` returns. */
export interface MobileCandidateLike {
  strategy: 'accessibilityId' | 'resourceId' | 'text' | 'point';
  locator: MobileLocatorLike;
  score: number;
  confidence: 'high' | 'medium' | 'low';
  unique: boolean;
  warnings: string[];
  code?: string;
}

/** The slice of `@pwtap/mobile-core` the mobile target uses. */
export interface MobileKit {
  locatorCandidates: (
    node: MobileNodeLike,
    hierarchy: MobileNodeLike[],
    options?: { appId?: string },
  ) => MobileCandidateLike[];
  findNodeByKey: (nodes: MobileNodeLike[], key: string) => MobileNodeLike | undefined;
  countMatches: (hierarchy: MobileNodeLike[], locator: MobileLocatorLike) => number;
}
