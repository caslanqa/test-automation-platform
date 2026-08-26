/**
 * The plan: what a sync would do, computed before anything is done.
 *
 * Pure — a function of the discovered tests and the cases already in the tool, with no I/O — which is
 * what lets `--dry-run` be the default and be trustworthy: the thing printed is the thing that would
 * run, not a second implementation of it.
 *
 * Matching happens in two passes, in this order:
 *
 * 1. **By id.** A `QaseID` annotation is an exact, permanent link and outranks everything. A test that
 *    was renamed and moved still finds its case.
 * 2. **By suite path and title.** Only for tests with no id yet. A match here is *adopted*: the id is
 *    written back so the next sync uses pass 1 and the link stops depending on the title.
 *
 * **Nothing is ever deleted.** A case the code no longer contains is an orphan: reported, and marked
 * deprecated only when explicitly asked. Deleting would throw away the run history that is the whole
 * reason the case existed.
 *
 * @example
 * const plan = planSync(tests, existingCases);
 * plan.create.length; // how many cases a --apply would add
 */
import type { NewTmsCase, TmsCase, TmsCasePatch } from '../provider.js';
import { testKey, type DiscoveredTest } from './discover.js';

export interface CreateEntry {
  test: DiscoveredTest;
  case: NewTmsCase;
}

export interface AdoptEntry {
  test: DiscoveredTest;
  caseId: string;
  /** True when the matched case was a manual one — automating it is the point, but say so out loud. */
  wasManual: boolean;
}

export interface UpdateEntry {
  test: DiscoveredTest;
  caseId: string;
  patch: TmsCasePatch;
  /** Human-readable field names that differ, for the dry-run report. */
  changed: string[];
}

export interface DanglingEntry {
  test: DiscoveredTest;
  caseId: string;
}

export interface SyncPlan {
  /** No id and no title match — a new case, and the id gets written back. */
  create: CreateEntry[];
  /** No id, but a case with this suite path and title already exists. Link it. */
  adopt: AdoptEntry[];
  /** Linked and drifted: title, suite or tags differ from the tool. */
  update: UpdateEntry[];
  /** Linked and identical. Listed only as a count. */
  unchanged: number;
  /** The annotation names a case that is not in the project any more. Reported, never recreated. */
  dangling: DanglingEntry[];
  /** Automated cases in the tool with no test in the code. Never deleted. */
  orphans: TmsCase[];
  /**
   * Tests that will be created or adopted but **cannot** carry an id in the source, because several
   * of them come from one `test()` call. They stay matched by title, which is the fragile link — so
   * they are surfaced rather than silently accepted.
   */
  unwritable: DiscoveredTest[];
}

function newCase(test: DiscoveredTest): NewTmsCase {
  return {
    ref: `${test.file}:${test.line}:${test.column}:${test.title}`,
    title: test.title,
    suitePath: test.suitePath,
    tags: test.tags,
    requirements: test.requirements,
  };
}

const sameList = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length &&
  [...left].sort().join('\u0000') === [...right].sort().join('\u0000');

function drift(
  test: DiscoveredTest,
  existing: TmsCase,
): UpdateEntry['patch'] & { changed: string[] } {
  const patch: TmsCasePatch = {};
  const changed: string[] = [];
  if (existing.title !== test.title) {
    patch.title = test.title;
    changed.push('title');
  }
  if (existing.suitePath.join('/') !== test.suitePath.join('/')) {
    patch.suitePath = test.suitePath;
    changed.push('suite');
  }
  if (!sameList(existing.tags, test.tags)) {
    patch.tags = test.tags;
    changed.push('tags');
  }
  // Only when the code names some: a project whose Qase has no requirement field reads back `[]` for
  // every case, and treating that as drift would rewrite the whole suite on every sync forever.
  if (test.requirements.length > 0 && !sameList(existing.requirements, test.requirements)) {
    patch.requirements = test.requirements;
    changed.push('requirements');
  }
  return { ...patch, changed };
}

export function planSync(tests: readonly DiscoveredTest[], existing: readonly TmsCase[]): SyncPlan {
  const byId = new Map(existing.map(item => [item.id, item]));
  const byKey = new Map<string, TmsCase>();
  for (const item of existing) {
    const key = testKey(item);
    // First one wins, deterministically: two cases with the same suite path and title is a duplicate in
    // the tool, and alternating between them would rewrite a different case on every sync.
    if (!byKey.has(key)) {
      byKey.set(key, item);
    }
  }

  const plan: SyncPlan = {
    create: [],
    adopt: [],
    update: [],
    unchanged: 0,
    dangling: [],
    orphans: [],
    unwritable: [],
  };

  /** Case ids the code accounts for — anything automated and outside this set is an orphan. */
  const claimed = new Set<string>();

  for (const test of tests) {
    const linkedId = test.caseIds.map(String).find(id => byId.has(id));

    // 1. linked by id.
    if (linkedId !== undefined) {
      claimed.add(linkedId);
      const existingCase = byId.get(linkedId) as TmsCase;
      const { changed, ...patch } = drift(test, existingCase);
      if (changed.length === 0) {
        plan.unchanged += 1;
      } else {
        plan.update.push({ test, caseId: linkedId, patch, changed });
      }
      continue;
    }

    // An annotation that names a case nobody can find. Recreating it would quietly start a second
    // history for the same test, so the human decides.
    if (test.caseIds.length > 0) {
      plan.dangling.push({ test, caseId: String(test.caseIds[0]) });
      continue;
    }

    // 2. matched by suite path and title.
    const match = byKey.get(testKey(test));
    if (match !== undefined && !claimed.has(match.id)) {
      claimed.add(match.id);
      const { changed, ...patch } = drift(test, match);
      if (changed.length > 0) {
        plan.update.push({ test, caseId: match.id, patch, changed });
      }
      if (test.unwritableReason === undefined) {
        plan.adopt.push({ test, caseId: match.id, wasManual: !match.automated });
      } else {
        // Nothing to apply: the id cannot be written, so the link is already in its final state and
        // will resolve the same way next run. Counting it as pending work would make `tms sync` exit 1
        // on every run of a suite that uses a parameterised loop or a test-declaring helper — which is
        // most suites — and a CI check that can never pass is a CI check people delete.
        plan.unwritable.push(test);
        if (changed.length === 0) {
          plan.unchanged += 1;
        }
      }
      continue;
    }

    plan.create.push({ test, case: newCase(test) });
    if (test.unwritableReason !== undefined) {
      plan.unwritable.push(test);
    }
  }

  plan.orphans = existing.filter(item => item.automated && !claimed.has(item.id));
  return plan;
}

/** Does this plan change anything? Used to keep `--apply` quiet when there is nothing to do. */
export function planIsEmpty(plan: SyncPlan): boolean {
  return plan.create.length === 0 && plan.adopt.length === 0 && plan.update.length === 0;
}
