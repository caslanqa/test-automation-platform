/**
 * `heal propose` — turn a locator-drift finding into a reviewable proposal.
 *
 * The order of the gates is the design. A candidate is generated only after the class allows it, an
 * equivalence is attempted only for a real candidate, a rerun happens only for a proven equivalence,
 * and an edit is applied only when every one of those held **and** the operator asked for it. Each
 * gate that stops the process is recorded by name, so a refusal is auditable rather than mysterious.
 *
 * Only `locator-drift` is ever examined. A `true-fail` is not refused after generating candidates for
 * it — it is never a candidate at all, which is a stronger guarantee than a veto applied late.
 *
 * @example
 * await proposeForFinding({ projectDir, finding, apply: false, verify: true });
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { appendHeal, type HealLogEntry } from '../metrics/healLog.js';
import { headCommit } from '../triage/gitDiff.js';
import type { Finding } from '../triage/run.js';
import { parseAriaSnapshot, snapshotFromErrorContext, type AriaNode } from './ariaSnapshot.js';
import { targetsFor, webLocatorCandidates, type HealCandidate } from './candidates.js';
import { eligibleForAutofix, proveEquivalence } from './equivalence.js';
import { parseLocatorIntent } from './intent.js';
import { proposeMobileRepair } from './mobile/propose.js';
import { readHierarchy } from './mobile/target.js';
import { applyEdit, planEdit, writeProposal, type Proposal } from './patch.js';
import { verifyCandidate } from './rerun.js';

export interface ProposeOptions {
  projectDir: string;
  finding: Finding;
  /** Write the edit into the spec. Requires a proven equivalence and a passing verification. */
  apply?: boolean;
  /** Run the candidate to confirm it. Off makes the proposal advisory only. */
  verify?: boolean;
  /** Sequence number, so two proposals for one test do not collide. */
  sequence?: number;
  /** Extra environment for the verification run. */
  env?: Record<string, string>;
  /**
   * Titles of tests in the same file that were already failing in the run being triaged. Passed to
   * the verification so a sibling that was red before the edit is not blamed on the candidate.
   */
  alreadyFailing?: readonly string[];
}

export interface ProposeOutcome {
  /** null when the finding was not even a candidate for repair. */
  proposal: Proposal | null;
  /** Where it was written, when it was. */
  dir?: string;
  /** Why nothing was examined, for the classes that are never repaired. */
  skipped?: string;
}

/** The ARIA snapshot Playwright captured at the failure, from the error-context attachment. */
function snapshotFor(projectDir: string, finding: Finding): AriaNode[] | undefined {
  const attachment = finding.failure?.attachments.find(item => item.name === 'error-context');
  if (attachment === undefined) {
    return undefined;
  }
  try {
    const markdown = fs.readFileSync(path.join(projectDir, attachment.path), 'utf8');
    const snapshot = snapshotFromErrorContext(markdown);
    return snapshot === undefined ? undefined : parseAriaSnapshot(snapshot);
  } catch {
    return undefined;
  }
}

/**
 * Record an applied heal in `heal/heal-log.jsonl`.
 *
 * This is what makes the precision and mask-rate metrics computable: neither is recoverable from the
 * run records, which describe failures rather than repairs. It runs only after the edit is committed
 * to the file, so the log never claims a heal that was rolled back.
 *
 * A failure here must not undo the edit, so it is swallowed with a warning. Losing a log line costs a
 * metric; throwing after the file was already written would leave the caller unable to tell whether
 * the spec had changed.
 */
function logApplied(projectDir: string, proposal: Proposal, finding: Finding): void {
  const at = new Date().toISOString();
  const site = finding.failure?.siteFingerprint ?? '';
  const entry: HealLogEntry = {
    healId: createHash('sha1')
      .update([proposal.testKey, site, at].join('\0'))
      .digest('hex')
      .slice(0, 12),
    at,
    commit: headCommit(projectDir),
    testKey: proposal.testKey,
    project: proposal.project,
    file: proposal.file,
    line: proposal.line,
    title: proposal.title,
    from: proposal.intent.code,
    to: proposal.chosen?.code ?? '',
    siteFingerprint: site,
    matcher: finding.failure?.matcher,
    triage: { class: proposal.triage.class, confidence: proposal.triage.confidence },
    proof: {
      verdict: proposal.equivalence?.verdict ?? 'refused',
      matched: proposal.equivalence?.matched ?? [],
    },
    verification:
      proposal.verification === undefined
        ? undefined
        : {
            greens: proposal.verification.greens,
            assertionRan: proposal.verification.assertionRan,
          },
  };
  try {
    appendHeal(projectDir, entry);
  } catch (error) {
    process.stderr.write(
      `[heal] applied the edit but could not write the heal log: ${(error as Error).message}\n`,
    );
  }
}

export async function proposeForFinding(options: ProposeOptions): Promise<ProposeOutcome> {
  const { projectDir, finding, apply = false, verify = true, sequence = 1 } = options;
  const { test, failure, triage } = finding;

  // Which engine. Decided by what the run recorded rather than by the Playwright project's name: a
  // captured hierarchy means the failure came through the mobile fixture, whatever the project is
  // called, and a user is free to rename `appium`.
  if (readHierarchy(projectDir, finding) !== undefined) {
    return proposeMobileRepair({ projectDir, finding, sequence });
  }

  // Gate 1: the class. Nothing else is ever examined, so a regression cannot be repaired even by
  // accident — there is no code path that generates a candidate for it.
  if (triage.class !== 'locator-drift') {
    return {
      proposal: null,
      skipped: `${triage.class}: only locator-drift is ever repaired${
        triage.class === 'true-fail'
          ? ' — a changed value is the test doing its job, and rewriting it would hide the bug'
          : ''
      }`,
    };
  }
  if (failure?.locatorCode === undefined) {
    return {
      proposal: null,
      skipped: 'the failure named no locator, so there is nothing to replace',
    };
  }

  const refusals: string[] = [];
  const checked: string[] = ['class is locator-drift'];

  // The classifier's own vetoes are refusals here, not advice.
  for (const veto of triage.vetoes) {
    if (veto !== 'not-locator-drift') {
      refusals.push(veto);
    }
  }
  if (triage.confidence < 85) {
    refusals.push(`confidence ${triage.confidence} is below the 85 needed to act`);
  } else {
    checked.push(`confidence ${triage.confidence} reaches the act band`);
  }

  const intent = parseLocatorIntent(failure.locatorCode);
  const tree = snapshotFor(projectDir, finding);
  if (tree === undefined || tree.length === 0) {
    return {
      proposal: null,
      skipped:
        'no ARIA snapshot was captured for this failure — Playwright writes one as the error-context attachment for matcher failures, and a mobile run writes a mobile-hierarchy attachment instead',
    };
  }
  checked.push('an ARIA snapshot of the failing page was available');

  const candidates = webLocatorCandidates(tree, intent);
  const proposal: Proposal = {
    testKey: test.testKey,
    project: test.project,
    target: 'web',
    file: failure.topFrame?.file ?? test.file,
    line: failure.topFrame?.line ?? test.line,
    title: test.titlePath.join(' › '),
    triage,
    intent,
    candidates,
    refusals,
    checked,
    applied: false,
  };

  if (candidates.length === 0) {
    proposal.refusals.push(
      targetsFor(tree, intent).length === 0
        ? 'no-target: nothing in the snapshot matches what this locator stated, so there is no element to point at'
        : 'no-candidate: the target has no attribute stable enough to build a locator from',
    );
    return { proposal, dir: writeProposal(projectDir, proposal, sequence) };
  }

  const [best, second] = candidates;
  proposal.chosen = best;

  // Gate 2: two candidates within five points pointing at different elements is ambiguity, not a
  // choice. Recorded as a refusal rather than an early return — a reviewer wants both "these were
  // indistinguishable" AND "none was provable anyway", and returning here would hide the second.
  if (second !== undefined && best.score - second.score < 5 && best.node !== second.node) {
    proposal.refusals.push(
      `ambiguous: the top two candidates score ${best.score} and ${second.score} and point at different elements`,
    );
  } else {
    proposal.checked.push('one candidate leads the ranking clearly');
  }

  // Gate 3: is it the same element? Always evaluated, so the report always says.
  const equivalence = proveEquivalence(intent, best, tree);
  proposal.equivalence = equivalence;
  if (!eligibleForAutofix(equivalence)) {
    proposal.refusals.push(`equivalence ${equivalence.verdict}: ${equivalence.reasons.join('; ')}`);
  } else {
    proposal.checked.push(`equivalence proven via ${equivalence.matched.join(' and ')}`);
  }

  // The edit is planned regardless, because a reviewer wants to see the diff even for a refusal.
  const planned = planEdit(
    projectDir,
    proposal.file,
    proposal.line,
    failure.locatorCode,
    best.code,
  );
  if ('problem' in planned) {
    proposal.refusals.push(`cannot-edit: ${planned.problem}`);
    return { proposal, dir: writeProposal(projectDir, proposal, sequence) };
  }
  proposal.edit = planned.edit;

  // Gate 4: run it. Only worth the minutes when everything above held.
  if (verify && proposal.refusals.length === 0) {
    // Apply, verify, and restore unless the operator asked to keep it — the candidate has to be in
    // the file for Playwright to run it, and leaving it there after a failed verification would be a
    // silent edit nobody approved.
    const original = fs.readFileSync(path.join(projectDir, proposal.file), 'utf8');
    applyEdit(projectDir, planned.edit);
    try {
      const verification = await verifyCandidate(
        {
          projectDir,
          file: proposal.file,
          title: test.titlePath[test.titlePath.length - 1] ?? proposal.title,
          project: test.project === '' ? undefined : test.project,
          env: options.env,
          alreadyFailing: options.alreadyFailing,
        },
        failure.matcher,
      );
      proposal.verification = verification;
      if (verification.ok) {
        proposal.checked.push(
          `${verification.greens} consecutive greens with retries off, and the original assertion still ran`,
        );
      } else {
        proposal.refusals.push(`verification failed: ${verification.reasons.join('; ')}`);
      }
    } finally {
      if (!(apply && proposal.refusals.length === 0)) {
        fs.writeFileSync(path.join(projectDir, proposal.file), original);
      } else {
        proposal.applied = true;
        logApplied(projectDir, proposal, finding);
      }
    }
  } else if (verify) {
    proposal.refusals.push('not verified: earlier gates already refused this candidate');
  } else if (apply) {
    // Said out loud rather than left to be inferred from `applied: false`. An unverified edit is
    // never written, and an operator who asked for one deserves to be told why they got nothing.
    proposal.refusals.push(
      'not applied: --no-verify was given, and an edit that was never run is not a repair',
    );
  }

  return { proposal, dir: writeProposal(projectDir, proposal, sequence) };
}

/** The candidate list without proving anything — used by the report for a refused proposal. */
export const rankedFor = (tree: readonly AriaNode[], locatorCode: string): HealCandidate[] =>
  webLocatorCandidates(tree, parseLocatorIntent(locatorCode));
