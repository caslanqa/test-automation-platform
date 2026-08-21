import type { JudgeVerdict } from '../types.js';

/** Total of one numeric field across the votes, treating a missing value as 0. */
function sum(
  verdicts: JudgeVerdict[],
  pick: (verdict: JudgeVerdict) => number | undefined,
): number {
  return verdicts.reduce((total, verdict) => total + (pick(verdict) ?? 0), 0);
}

/** Middle score of the votes (mean of the two middles when even) — one outlier cannot drag it. */
function medianScore(verdicts: JudgeVerdict[]): number {
  const scores = verdicts.map(verdict => verdict.score).sort((a, b) => a - b);
  const middle = Math.floor(scores.length / 2);

  return scores.length % 2 === 1
    ? scores[middle]
    : Math.round((scores[middle - 1] + scores[middle]) / 2);
}

/**
 * Combine several judgements of the same material into one. A pass needs a STRICT majority, so a tie —
 * or a panel that cannot agree — fails: judges disagreeing is not evidence that the material is right.
 * The kept reasoning and checklist come from a voter on the winning side, and the split is stated in
 * `reasoning` whenever the vote was not unanimous.
 * @example aggregateVerdicts([passVerdict, passVerdict, failVerdict]); // pass, score = median
 */
export function aggregateVerdicts(verdicts: JudgeVerdict[]): JudgeVerdict {
  if (verdicts.length === 0) {
    throw new Error('[ai-judge] no verdicts to aggregate');
  }
  if (verdicts.length === 1) {
    return verdicts[0];
  }

  const passes = verdicts.filter(verdict => verdict.pass).length;
  const pass = passes > verdicts.length / 2;
  const agreeing = verdicts.filter(verdict => verdict.pass === pass);
  const representative = agreeing[0];
  const unanimous = agreeing.length === verdicts.length;
  const split = `Judges ${agreeing.length}/${verdicts.length} → ${pass ? 'pass' : 'fail'}`;
  const models = verdicts
    .map(verdict => verdict._meta?.selectedModel)
    .filter((id): id is string => id !== undefined);

  return {
    pass,
    score: medianScore(verdicts),
    reasoning: unanimous ? representative.reasoning : `${split}. ${representative.reasoning}`,
    ...(representative.criteria === undefined ? {} : { criteria: representative.criteria }),
    ...(representative._meta === undefined
      ? {}
      : {
          _meta: {
            ...representative._meta,
            selectedModel: [...new Set(models)].join(', ') || representative._meta.selectedModel,
            votes: verdicts.length,
            agreement: agreeing.length / verdicts.length,
            // What the panel cost as a whole, not what one voter cost. `latencyMs` therefore sums the votes
            // even though they ran concurrently: it is time spent judging, not time elapsed.
            cached: verdicts.every(verdict => verdict._meta?.cached === true),
            calls: sum(verdicts, verdict => verdict._meta?.calls),
            latencyMs: sum(verdicts, verdict => verdict._meta?.latencyMs),
          },
        }),
  };
}
