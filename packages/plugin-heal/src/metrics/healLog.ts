/**
 * `heal/heal-log.jsonl` — the append-only record of every heal that was applied.
 *
 * Committed, one JSON object per line, never rewritten. It is what makes the metrics in
 * `healMetrics.ts` computable at all: precision needs to know when a heal landed and at which commit,
 * and the mask rate needs to know what the locator was before it changed. Neither is recoverable from
 * the run records, because the run records describe failures rather than repairs.
 *
 * Append-only is the point. A heal that turns out to have hidden a bug is the most important entry in
 * the file, and a format that allowed it to be edited away would make the one metric that matters
 * unauditable.
 *
 * @example
 * appendHeal('/repo', entry);
 * readHealLog('/repo').filter(entry => entry.revertReason === 'masked-bug');
 */
import fs from 'node:fs';
import path from 'node:path';

import type { EquivalenceVerdict } from '../heal/equivalence.js';
import type { TriageClass } from '../triage/classify.js';

export const HEAL_LOG_PATH = path.join('heal', 'heal-log.jsonl');

/** Why a heal was undone. Only the first two count as masking; the third is ordinary churn. */
export type RevertReason = 'masked-bug' | 'wrong-element' | 'no-longer-needed';

export interface HealLogEntry {
  healId: string;
  /** When it was applied. */
  at: string;
  commit?: string;
  testKey: string;
  project: string;
  /** The spec file the edit landed in, relative to the project. */
  file: string;
  line: number;
  title: string;
  /** The locator before and after. */
  from: string;
  to: string;
  /** The site that was failing, so a later failure can be compared against it. */
  siteFingerprint: string;
  matcher?: string;
  triage: { class: TriageClass; confidence: number };
  proof: { verdict: EquivalenceVerdict; matched: string[] };
  verification?: { greens: number; assertionRan: boolean };
  /** Set by `heal revert` — the ground-truth label for the mask rate. */
  revertedAt?: string;
  revertReason?: RevertReason;
  revertNote?: string;
}

export function appendHeal(projectDir: string, entry: HealLogEntry): void {
  const target = path.join(projectDir, HEAL_LOG_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${JSON.stringify(entry)}\n`);
}

/**
 * Read the log. A malformed line is skipped rather than throwing: a hand-edited file must not blind
 * the metrics, and the metrics report how many lines they could not read.
 */
export function readHealLog(projectDir: string): { entries: HealLogEntry[]; unreadable: number } {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(projectDir, HEAL_LOG_PATH), 'utf8');
  } catch {
    return { entries: [], unreadable: 0 };
  }
  const entries: HealLogEntry[] = [];
  let unreadable = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as HealLogEntry;
      if (typeof parsed.healId === 'string' && typeof parsed.testKey === 'string') {
        entries.push(parsed);
      } else {
        unreadable += 1;
      }
    } catch {
      unreadable += 1;
    }
  }
  return { entries, unreadable };
}

/**
 * Record a revert. Appends a new line rather than editing the original, so the history of what was
 * believed and when stays intact — the file is the audit trail, not a current-state document.
 */
export function appendRevert(
  projectDir: string,
  healId: string,
  reason: RevertReason,
  note?: string,
): HealLogEntry | undefined {
  const { entries } = readHealLog(projectDir);
  const original = entries.find(entry => entry.healId === healId && entry.revertedAt === undefined);
  if (original === undefined) {
    return undefined;
  }
  const reverted: HealLogEntry = {
    ...original,
    revertedAt: new Date().toISOString(),
    revertReason: reason,
    revertNote: note,
  };
  appendHeal(projectDir, reverted);
  return reverted;
}

/**
 * The current state of each heal: the latest line wins, so a revert supersedes the entry it names.
 * Everything else reads this rather than the raw lines.
 */
export function currentHeals(entries: readonly HealLogEntry[]): HealLogEntry[] {
  const byId = new Map<string, HealLogEntry>();
  for (const entry of entries) {
    const existing = byId.get(entry.healId);
    // A revert always supersedes; between two of the same kind the later `at` wins.
    if (
      existing === undefined ||
      (entry.revertedAt !== undefined && existing.revertedAt === undefined) ||
      entry.at > existing.at
    ) {
      byId.set(entry.healId, entry);
    }
  }
  return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
}
