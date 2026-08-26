/**
 * The suite tree, read once and grown as needed.
 *
 * Qase stores a suite as `{ id, title, parent_id }` — a path is something you reconstruct. This module
 * does that once per sync and keeps the index, because the alternative is a lookup call per test, and a
 * 500-test suite would spend its whole rate-limit budget re-deriving the same tree.
 *
 * `ensurePath` is idempotent by construction: it walks the segments, reuses what exists, creates only
 * what is missing, and records each creation in the index so the next test down the same directory
 * costs nothing.
 *
 * @example
 * const suites = await loadSuites(client);
 * await ensurePath(client, suites, ['checkout', 'cart']); // → 17
 */
import type { QaseClient } from './client.js';

interface QaseSuite {
  id: number;
  title: string;
  parent_id?: number | null;
}

export interface SuiteIndex {
  /** `'checkout/cart'` → suite id. The separator cannot appear in a segment, so it is unambiguous. */
  byPath: Map<string, number>;
  /** Suite id → its path, for turning a case's `suite_id` back into a path. */
  pathById: Map<number, string[]>;
}

/** The index key for a path. `/` is safe: a Qase suite title containing one is escaped below. */
export function pathKey(segments: readonly string[]): string {
  return segments.map(segment => segment.replace(/\//g, '\\/')).join('/');
}

export async function loadSuites(client: QaseClient): Promise<SuiteIndex> {
  const suites = await client.list<QaseSuite>(`/suite/${client.project}`);
  const byId = new Map(suites.map(suite => [suite.id, suite]));

  const pathById = new Map<number, string[]>();
  /**
   * `undefined` when the ancestry does not resolve — a parent that is not in the list, or a cycle.
   * Neither should happen (the list is walked to exhaustion, and the UI cannot make a cycle), and if one
   * does, the suite gets no path at all rather than being silently promoted to the root: a phantom root
   * suite would collide with a real one of the same name and file cases into the wrong place.
   */
  const resolve = (id: number, seen: Set<number>): string[] | undefined => {
    const cached = pathById.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const suite = byId.get(id);
    if (suite === undefined || seen.has(id)) {
      return undefined;
    }
    seen.add(id);
    const parent = suite.parent_id ?? null;
    if (parent === null) {
      pathById.set(id, [suite.title]);
      return [suite.title];
    }
    const above = resolve(parent, seen);
    if (above === undefined) {
      return undefined;
    }
    const path = [...above, suite.title];
    pathById.set(id, path);
    return path;
  };

  const byPath = new Map<string, number>();
  for (const suite of suites) {
    const path = resolve(suite.id, new Set());
    if (path !== undefined && path.length > 0) {
      // First one wins: two sibling suites with the same title is a Qase-side mistake, and silently
      // switching between them on alternate syncs would move cases around for no visible reason.
      const key = pathKey(path);
      if (!byPath.has(key)) {
        byPath.set(key, suite.id);
      }
    }
  }

  return { byPath, pathById };
}

/** The suite id for a path, creating any missing level. Returns `undefined` for an empty path. */
export async function ensurePath(
  client: QaseClient,
  index: SuiteIndex,
  segments: readonly string[],
): Promise<number | undefined> {
  let parent: number | undefined;
  const walked: string[] = [];

  for (const segment of segments) {
    walked.push(segment);
    const key = pathKey(walked);
    const existing = index.byPath.get(key);
    if (existing !== undefined) {
      parent = existing;
      continue;
    }
    const created = await client.post<{ id: number }>(`/suite/${client.project}`, {
      title: segment,
      ...(parent === undefined ? {} : { parent_id: parent }),
    });
    index.byPath.set(key, created.id);
    index.pathById.set(created.id, [...walked]);
    parent = created.id;
  }

  return parent;
}
