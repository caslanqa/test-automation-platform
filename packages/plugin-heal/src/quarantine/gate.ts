/**
 * The CI gate over the quarantine list. Pure: the CLI reads the file and prints, this decides.
 *
 * Each gate protects against a specific way quarantine rots into a permanent hiding place. The one
 * that actually changes behaviour is the **ratchet**: the list may shrink freely, but growth needs a
 * reason in the PR. It costs nothing to compute — `git show HEAD~1:heal/quarantine.json` needs no
 * store — and it is the difference between a budget and a suggestion.
 *
 * @example
 * gateQuarantine({ entries, now: Date.now(), totalTests: 400 });
 * // → { ok: false, violations: [{ gate: 'expired', … }] }
 */
import type { QuarantineEntry } from './file.js';
import { isExpired } from './shield.js';

export type GateName =
  | 'expired'
  | 'max-entries'
  | 'max-share'
  | 'max-ttl'
  | 'missing-issue'
  | 'weak-evidence'
  | 'ratchet';

export interface GateViolation {
  gate: GateName;
  message: string;
  /** The entries responsible, so the output names them rather than reporting a count. */
  entries: string[];
}

export interface GateOptions {
  entries: readonly QuarantineEntry[];
  now: number;
  /** How many tests the suite has, for the share gate. Omit to skip that gate. */
  totalTests?: number;
  /** The list as it was on the previous commit, for the ratchet. Omit to skip. */
  previous?: readonly QuarantineEntry[];
  maxEntries?: number;
  /** As a share of `totalTests`. */
  maxShare?: number;
  maxTtlDays?: number;
  /** Days an entry may go without an issue link. */
  issueGraceDays?: number;
  /** Minimum measured flake rate for an entry to count as evidence-backed. */
  minFlakeRate?: number;
  /** Minimum runs behind that flake rate. */
  minRuns?: number;
}

export interface GateResult {
  ok: boolean;
  violations: GateViolation[];
  /** Total quarantine-days currently committed, which is what the ratchet compares. */
  quarantineDays: number;
  oldestAgeDays: number;
}

export const GATE_DEFAULTS = {
  maxEntries: 5,
  maxShare: 0.02,
  maxTtlDays: 30,
  issueGraceDays: 7,
  minFlakeRate: 0.2,
  minRuns: 10,
} as const;

const DAY = 86_400_000;
const ageDays = (entry: QuarantineEntry, now: number): number =>
  Math.floor((now - Date.parse(entry.addedAt)) / DAY);
const ttlDays = (entry: QuarantineEntry): number =>
  Math.round((Date.parse(entry.expiresAt) - Date.parse(entry.addedAt)) / DAY);

/** Days of shielding a list represents — an entry's whole window, not what is left of it. */
const totalQuarantineDays = (entries: readonly QuarantineEntry[]): number =>
  entries.reduce((sum, entry) => sum + Math.max(0, ttlDays(entry)), 0);

export function gateQuarantine(options: GateOptions): GateResult {
  const {
    entries,
    now,
    totalTests,
    previous,
    maxEntries = GATE_DEFAULTS.maxEntries,
    maxShare = GATE_DEFAULTS.maxShare,
    maxTtlDays = GATE_DEFAULTS.maxTtlDays,
    issueGraceDays = GATE_DEFAULTS.issueGraceDays,
    minFlakeRate = GATE_DEFAULTS.minFlakeRate,
    minRuns = GATE_DEFAULTS.minRuns,
  } = options;

  const violations: GateViolation[] = [];
  const named = (list: readonly QuarantineEntry[]): string[] =>
    list.map(entry => `${entry.project === '' ? '' : `[${entry.project}] `}${entry.title}`);

  const expired = entries.filter(entry => isExpired(entry, now));
  if (expired.length > 0) {
    violations.push({
      gate: 'expired',
      message: `${expired.length} quarantine entr${expired.length === 1 ? 'y has' : 'ies have'} expired — fix the test or renew with a reason`,
      entries: named(expired),
    });
  }

  if (entries.length > maxEntries) {
    violations.push({
      gate: 'max-entries',
      message: `${entries.length} quarantined tests, budget is ${maxEntries} — quarantine is not a flake strategy`,
      entries: named(entries),
    });
  }

  if (totalTests !== undefined && totalTests > 0 && entries.length / totalTests > maxShare) {
    violations.push({
      gate: 'max-share',
      message: `${entries.length}/${totalTests} tests quarantined (${(
        (entries.length / totalTests) *
        100
      ).toFixed(1)}%), budget is ${(maxShare * 100).toFixed(1)}%`,
      entries: named(entries),
    });
  }

  const tooLong = entries.filter(entry => ttlDays(entry) > maxTtlDays);
  if (tooLong.length > 0) {
    violations.push({
      gate: 'max-ttl',
      message: `an entry may be quarantined for at most ${maxTtlDays} days at a time`,
      entries: named(tooLong),
    });
  }

  const unfiled = entries.filter(
    entry => entry.issue === undefined && ageDays(entry, now) > issueGraceDays,
  );
  if (unfiled.length > 0) {
    violations.push({
      gate: 'missing-issue',
      message: `quarantined for more than ${issueGraceDays} days with no issue link — quarantining is not filing`,
      entries: named(unfiled),
    });
  }

  // Evidence is what separates "measured as intermittent" from "red and inconvenient". An entry
  // without it is a deterministic failure wearing the word flaky.
  const weak = entries.filter(entry => {
    const evidence = entry.evidence;
    if (evidence === undefined) {
      return true;
    }
    return evidence.runs < minRuns || evidence.flakeRate < minFlakeRate;
  });
  if (weak.length > 0) {
    violations.push({
      gate: 'weak-evidence',
      message: `needs a measured flake rate of at least ${minFlakeRate} over at least ${minRuns} runs`,
      entries: named(weak),
    });
  }

  const quarantineDays = totalQuarantineDays(entries);
  if (previous !== undefined) {
    const before = totalQuarantineDays(previous);
    if (quarantineDays > before) {
      violations.push({
        gate: 'ratchet',
        message: `total quarantine grew from ${before} to ${quarantineDays} days — the list may shrink freely, growth needs a reason in the PR`,
        entries: named(
          entries.filter(entry => !previous.some(old => old.testKey === entry.testKey)),
        ),
      });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    quarantineDays,
    oldestAgeDays: entries.reduce((max, entry) => Math.max(max, ageDays(entry, now)), 0),
  };
}
