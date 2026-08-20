/**
 * Cohen's kappa over K classes — agreement corrected for what two raters would hit by chance.
 *
 * This generalises `@pwtap/plugin-ai-judge`'s binary `kappa()`, and a test asserts the two agree on
 * two-class input so the generalisation stays honest. It is the number the calibration gate keys on
 * rather than accuracy: triage has five classes with a real `unknown` base rate, so accuracy is
 * inflated by whichever class dominates the dataset. A classifier that answered `env-infra` to
 * everything would score well on accuracy and zero on kappa.
 *
 * @example
 * kappaMulti([{ expected: 'flaky', actual: 'flaky' }, { expected: 'true-fail', actual: 'flaky' }]);
 * // → 0 (the agreement is exactly what chance predicts)
 */

export interface RatedPair<T extends string = string> {
  expected: T;
  actual: T;
}

export function kappaMulti<T extends string>(pairs: ReadonlyArray<RatedPair<T>>): number {
  const total = pairs.length;
  if (total === 0) {
    return 0;
  }

  const observed = pairs.filter(pair => pair.expected === pair.actual).length / total;

  // Chance agreement is the sum, over classes, of the product of the two raters' marginals.
  const classes = new Set<T>([
    ...pairs.map(pair => pair.expected),
    ...pairs.map(pair => pair.actual),
  ]);
  let chance = 0;
  for (const klass of classes) {
    const expectedShare = pairs.filter(pair => pair.expected === klass).length / total;
    const actualShare = pairs.filter(pair => pair.actual === klass).length / total;
    chance += expectedShare * actualShare;
  }

  // Both raters used exactly one class: chance agreement is total, so kappa is undefined. Report the
  // observed extreme rather than dividing by zero — the same guard the binary version uses.
  if (chance === 1) {
    return observed === 1 ? 1 : 0;
  }
  return (observed - chance) / (1 - chance);
}

/** Per-class counts, so a report can say *which* class the classifier is confusing. */
export interface ConfusionRow<T extends string = string> {
  klass: T;
  expected: number;
  actual: number;
  correct: number;
}

export function confusion<T extends string>(
  pairs: ReadonlyArray<RatedPair<T>>,
): Array<ConfusionRow<T>> {
  const classes = [
    ...new Set<T>([...pairs.map(pair => pair.expected), ...pairs.map(pair => pair.actual)]),
  ].sort();
  return classes.map(klass => ({
    klass,
    expected: pairs.filter(pair => pair.expected === klass).length,
    actual: pairs.filter(pair => pair.actual === klass).length,
    correct: pairs.filter(pair => pair.expected === klass && pair.actual === klass).length,
  }));
}
