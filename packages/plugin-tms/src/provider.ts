/**
 * The seam a second test management tool plugs into.
 *
 * It carries **only the methods a provider implements today**. A member with no caller is a member
 * nobody can get right, and an interface written for an imaginary second tool is fiction until that tool
 * exists — so case sync, requirement linking and defect creation join this file in the phase that ships
 * them, not before.
 *
 * The neutral model below is deliberately thin. `severity`, `priority` and `layer` are strings, not the
 * integers Qase's API wants: the mapping is the provider's job (`providers/qase/map.ts`), because the
 * next tool's integers are different ones and a shared enum would just be Qase's enum wearing a hat.
 *
 * @example
 * const provider = resolveProvider(readConfig());
 * const run = await provider.createRun({ title: 'main · a1b2c3d · staging' });
 */
import type { Reporter } from '@playwright/test/reporter';

/** What `tms doctor` reports: can we reach the tool, and as whom. */
export interface TmsProbe {
  ok: boolean;
  /** One line per check, already human-readable. */
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export interface TmsRunInput {
  title: string;
  description?: string;
  /** Provider-side environment slug (Qase: `environment_slug`). */
  environment?: string;
  milestoneId?: number;
  planId?: number;
  tags?: string[];
}

export interface TmsRunRef {
  /** Provider-native run id, as a string so a provider with non-numeric ids stays expressible. */
  id: string;
  /** A link a human can open, when the provider gives one. */
  url?: string;
}

/** A case as it exists in the tool. `suitePath` is resolved by the provider, not stored as an id. */
export interface TmsCase {
  id: string;
  title: string;
  suitePath: string[];
  tags: string[];
  /** Requirement keys the tool currently stores for this case. Empty when it stores none. */
  requirements: string[];
  /** False for a manual case. Only automated cases are ever considered orphaned by a code sync. */
  automated: boolean;
}

export interface NewTmsCase {
  /** The caller's own key, echoed back with the new id — the only way to match a batch to its inputs. */
  ref: string;
  title: string;
  suitePath: string[];
  tags: string[];
  requirements: string[];
}

export interface TmsCasePatch {
  title?: string;
  suitePath?: string[];
  tags?: string[];
  requirements?: string[];
  /** Mark a case the code no longer contains. Never a delete — see `deprecateCase`. */
  deprecated?: boolean;
}

export interface TmsProvider {
  readonly id: string;
  /** Connectivity, credentials and project existence. Never throws — it reports. */
  probe(): Promise<TmsProbe>;
  createRun(input: TmsRunInput): Promise<TmsRunRef>;
  completeRun(runId: string): Promise<void>;

  /**
   * Can this project store a requirement key against a case, and where?
   *
   * Asked once, before a sync writes anything, so the answer is printed once instead of being
   * discovered per case. `ok: false` is not an error — the local traceability matrix is the
   * deliverable and the tool-side link is the mirror.
   */
  requirementSupport(): Promise<{ ok: boolean; detail: string }>;
  /** Every case in the project, with its suite path resolved. Paginated internally. */
  listCases(): Promise<TmsCase[]>;
  /** Create in bulk, and return each new id next to the `ref` it came from. */
  createCases(cases: NewTmsCase[]): Promise<Array<{ ref: string; id: string }>>;
  updateCase(id: string, patch: TmsCasePatch): Promise<void>;

  /** Open defects, so a failure already tracked does not open a second one. */
  listOpenDefects(): Promise<Array<{ id: string; title: string }>>;
  createDefect(defect: { title: string; actualResult: string }): Promise<string>;
  /** One-way: the quarantine list is the source of truth, the tool is the mirror. */
  setCaseFlaky(caseId: string, flaky: boolean): Promise<void>;
  /**
   * A constructed Playwright reporter, or `null` for a provider with no result sync of its own.
   *
   * The provider *builds* it rather than naming a module for someone else to load, which is what keeps
   * `src/reporter.ts` — the neutral wrapper the client's config points at — free of any provider's
   * package name. Synchronous because Playwright constructs reporters while loading the config.
   */
  createReporter(): Reporter | null;
}
