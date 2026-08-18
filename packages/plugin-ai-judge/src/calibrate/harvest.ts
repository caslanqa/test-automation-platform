import fs from 'fs';
import path from 'path';

import { responseUnderTest } from '../ai/judge/judgePrompt.js';
import type { Criterion, JudgeInput } from '../ai/types.js';

/** A drafted calibration case: the material, the label the JUDGE gave it, and why it needs a human. */
export interface HarvestedCase {
  name: string;
  /** Pre-filled from the judge's own verdict — a human confirms or flips it, which is the whole point. */
  expected: 'pass' | 'fail';
  input: JudgeInput;
  /** What the judge said, so a reviewer can decide without re-running anything. */
  judgeSaid: { score: number; reasoning: string; unmet?: string[] };
}

/** Outcome of a harvest: the drafted cases plus what was skipped and why. */
export interface HarvestResult {
  cases: HarvestedCase[];
  /** Entries written before the material was recorded, or that carried an image. */
  skipped: { withoutMaterial: number; withImage: number; duplicates: number };
}

interface CachedEntry {
  pass?: boolean;
  score?: number;
  reasoning?: string;
  criteria?: Criterion[];
  input?: JudgeInput & { hasImage?: boolean };
}

/**
 * A short label for the review list, taken from the answer under test — several cases usually share one
 * rubric, so naming them after it produces a file of identical labels.
 */
function nameFor(input: JudgeInput, index: number): string {
  const source = responseUnderTest(input) ?? input.userMessage ?? input.rubric ?? '';
  const words = source.split(/\s+/).slice(0, 10).join(' ');

  return words.length > 0 ? words : `case ${index + 1}`;
}

/**
 * How badly this case wants a human: a verdict that sat between the extremes, or a checklist the judge
 * only partly met, is where a judge is least reliable and a label is worth most. Lower sorts first.
 */
function reviewRank(entry: CachedEntry): number {
  const score = entry.score ?? 0;
  const partial =
    (entry.criteria ?? []).some(item => item.met) &&
    !(entry.criteria ?? []).every(item => item.met);

  return (partial ? 0 : 1) * 100 + Math.abs(score - 50);
}

/** Same material judged twice (two samples, two models) yields one case, not two. */
function materialKey(input: JudgeInput): string {
  return JSON.stringify([
    input.rubric ?? '',
    input.userMessage ?? '',
    input.botResponse ?? '',
    input.context ?? '',
    input.conversation ?? '',
  ]);
}

/**
 * Draft calibration cases out of `.judge/cache` — every assertion a test run already judged, labelled
 * with what the judge said, ordered so the least certain verdicts come first. A human then corrects the
 * labels; that correction is what makes the resulting numbers mean anything.
 * @example const { cases } = harvestCases(); // after a normal `npm test`
 */
export function harvestCases(dir = path.join(process.cwd(), '.judge', 'cache')): HarvestResult {
  const skipped = { withoutMaterial: 0, withImage: 0, duplicates: 0 };
  if (!fs.existsSync(dir)) {
    return { cases: [], skipped };
  }

  const entries: CachedEntry[] = [];
  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.json'))) {
    try {
      entries.push(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as CachedEntry);
    } catch {
      skipped.withoutMaterial++; // an unreadable entry is no different from one with no material
    }
  }

  const seen = new Set<string>();
  const usable: CachedEntry[] = [];
  for (const entry of entries) {
    if (entry.input === undefined || typeof entry.pass !== 'boolean') {
      skipped.withoutMaterial++;
      continue;
    }
    if (entry.input.hasImage === true) {
      skipped.withImage++;
      continue;
    }
    const key = materialKey(entry.input);
    if (seen.has(key)) {
      skipped.duplicates++;
      continue;
    }
    seen.add(key);
    usable.push(entry);
  }

  const cases = usable
    // Rank first, then material: two equally certain verdicts must not order by readdir order, which
    // differs between machines and would make the drafted file churn.
    .sort(
      (a, b) =>
        reviewRank(a) - reviewRank(b) ||
        materialKey(a.input ?? {}).localeCompare(materialKey(b.input ?? {})),
    )
    .map((entry, index) => {
      const { hasImage: _omitted, ...input } = entry.input as JudgeInput & { hasImage?: boolean };
      const unmet = (entry.criteria ?? []).filter(item => !item.met).map(item => item.criterion);

      return {
        name: nameFor(input, index),
        expected: entry.pass === true ? ('pass' as const) : ('fail' as const),
        input,
        judgeSaid: {
          score: entry.score ?? 0,
          reasoning: entry.reasoning ?? '',
          ...(unmet.length > 0 ? { unmet } : {}),
        },
      };
    });

  return { cases, skipped };
}

/** The harvest as a dataset file `judge:calibrate` can read, with the review instruction inside it. */
export function harvestToDataset(result: HarvestResult): string {
  return `${JSON.stringify(
    {
      _note:
        'DRAFT — each `expected` is what the JUDGE said, not what a human said. Read the cases in order (the least certain come first), flip the labels the judge got wrong, delete what you do not care about, then run judge:calibrate on this file. Until a human has reviewed it, a 100% score here only means the judge agrees with itself.',
      cases: result.cases,
    },
    null,
    2,
  )}\n`;
}
