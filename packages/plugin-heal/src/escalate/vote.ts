/**
 * Combining several models' answers.
 *
 * The policy is `plugin-ai-judge`'s `aggregateVerdicts`, restated for a label instead of a pass/fail —
 * the code is not reusable (there is no median of a class name) but the doctrine is, and it is the
 * important half: *"a tie fails: judges disagreeing is not evidence that the material is right."*
 *
 * Here that reads: **a tie is `unknown`**. A split panel has not produced a reason to move off the
 * deterministic answer, and `unknown` is the class that authorises nothing.
 *
 * @example
 * majorityClass(['flaky', 'flaky', 'true-fail']);   // { class: 'flaky', agreement: 0.67 }
 * majorityClass(['flaky', 'true-fail', 'unknown']); // { class: 'unknown', agreement: 0 } — a tie
 */
import type { TriageClass } from '../triage/classify.js';

export interface PanelResult {
  class: TriageClass;
  /** Share of votes for the winner, or 0 for a tie. */
  agreement: number;
  votes: number;
  /** Every vote, in the order the models were asked, for the provenance record. */
  ballots: TriageClass[];
}

export function majorityClass(ballots: readonly TriageClass[]): PanelResult {
  const cast = [...ballots];
  if (cast.length === 0) {
    return { class: 'unknown', agreement: 0, votes: 0, ballots: cast };
  }

  const counts = new Map<TriageClass, number>();
  for (const ballot of cast) {
    counts.set(ballot, (counts.get(ballot) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [leader, leaderCount] = ranked[0];
  const runnerUpCount = ranked[1]?.[1] ?? 0;

  // Strict plurality. Equal leaders are a panel that could not agree, and that is not a finding.
  if (leaderCount === runnerUpCount) {
    return { class: 'unknown', agreement: 0, votes: cast.length, ballots: cast };
  }
  return {
    class: leader,
    agreement: leaderCount / cast.length,
    votes: cast.length,
    ballots: cast,
  };
}
