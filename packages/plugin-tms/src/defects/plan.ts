/**
 * Which failures become defects, and which emphatically do not.
 *
 * **Only `true-fail`.** A flaky test opening a defect is the most harmful thing this plugin could do:
 * it fills the tracker with noise, trains people to close defects unread, and buries the real one. So
 * the filter is a whitelist of exactly one class, and every other finding is reported with the reason
 * it was skipped rather than silently dropped — a skip nobody can see is indistinguishable from a bug.
 *
 * heal already made the classification; this makes no judgement of its own beyond that. In particular
 * it does not second-guess a `low`-confidence `true-fail`: heal's bands are its own contract, and
 * re-thresholding here would be a second, invisible policy.
 *
 * Deduplication is by **title**, deliberately. A defect's title is derived from the test — its
 * describes, its name and its file — so the same failing test produces the identical title every run,
 * and an open defect with that title means this failure is already tracked. That needs no custom field
 * and no marker string in the body: the identity is already in the thing a human reads.
 *
 * @example
 * const plan = planDefects(triage.findings, openDefects);
 * plan.open.length;   // how many defects --apply would create
 * plan.skipped[0];    // { finding, reason: 'flaky — a defect here is noise, not a bug' }
 */
import type { TriageClass, TriageFinding } from '../heal/read.js';

/** The one class that becomes a defect. */
export const DEFECT_CLASS: TriageClass = 'true-fail';

const SKIP_REASON: Record<Exclude<TriageClass, 'true-fail'>, string> = {
  flaky: 'flaky — a defect here is noise, and noise is how a tracker stops being read',
  'locator-drift': 'locator-drift — the test needs repairing, not the product',
  'env-infra': 'env-infra — the environment failed, not the code under test',
  unknown: 'unknown — heal could not classify it, and guessing is not this command’s job',
};

export interface OpenEntry {
  finding: TriageFinding;
  title: string;
  actualResult: string;
}

export interface SkippedEntry {
  finding: TriageFinding;
  reason: string;
}

export interface ExistingEntry {
  finding: TriageFinding;
  title: string;
  defectId: string;
}

export interface DefectPlan {
  /** Would be created by `--apply`. */
  open: OpenEntry[];
  /** Already tracked: an open defect carries this title. */
  existing: ExistingEntry[];
  /** Not a defect, with the reason. */
  skipped: SkippedEntry[];
}

/**
 * The defect title for a finding: what failed, and where.
 *
 * Deterministic on purpose — it is also the deduplication key. The file is part of it because two
 * suites can legitimately hold a test of the same name, and a defect that merges them helps nobody.
 */
export function defectTitle(finding: TriageFinding): string {
  return `${finding.title} — ${finding.file}`;
}

/**
 * The defect body.
 *
 * Everything here comes from heal's report; nothing is inferred. The run id and commit are included
 * because a defect nobody can trace back to a run is a defect nobody can reproduce.
 */
export function defectBody(
  finding: TriageFinding,
  run: { runId: string; commit?: string; startedAt?: string },
): string {
  const lines = [
    `${finding.title}`,
    '',
    `File:       ${finding.file}${finding.line === undefined ? '' : `:${finding.line}`}`,
    `Project:    ${finding.project}`,
    `Outcome:    ${finding.outcome}`,
    `Triage:     ${finding.class} (${finding.confidence}% — ${finding.band})`,
    `Run:        ${run.runId}${run.commit === undefined ? '' : ` at ${run.commit}`}`,
    ...(run.startedAt === undefined ? [] : [`Started:    ${run.startedAt}`]),
  ];

  const reasons = finding.reasons ?? [];
  if (reasons.length > 0) {
    lines.push('', 'Why heal classified it this way:');
    for (const reason of reasons) {
      lines.push(`  - ${reason}`);
    }
  }

  lines.push(
    '',
    'Opened by @pwtap/plugin-tms from a heal triage report. Only true-fail findings reach here;',
    'flaky, locator-drift and env-infra never do.',
  );
  return lines.join('\n');
}

export function planDefects(
  findings: readonly TriageFinding[],
  openDefects: ReadonlyArray<{ id: string; title: string }>,
  run: { runId: string; commit?: string; startedAt?: string },
): DefectPlan {
  const byTitle = new Map(openDefects.map(defect => [defect.title, defect.id]));
  const plan: DefectPlan = { open: [], existing: [], skipped: [] };
  const claimed = new Set<string>();

  for (const finding of findings) {
    if (finding.class !== DEFECT_CLASS) {
      plan.skipped.push({
        finding,
        reason: SKIP_REASON[finding.class as Exclude<TriageClass, 'true-fail'>] ?? finding.class,
      });
      continue;
    }

    const title = defectTitle(finding);
    const existing = byTitle.get(title);
    if (existing !== undefined) {
      plan.existing.push({ finding, title, defectId: existing });
      continue;
    }
    // Two findings for one test — the same test failing on two projects — must not open two defects
    // in one command either.
    if (claimed.has(title)) {
      plan.existing.push({ finding, title, defectId: 'pending' });
      continue;
    }
    claimed.add(title);
    plan.open.push({ finding, title, actualResult: defectBody(finding, run) });
  }

  return plan;
}
