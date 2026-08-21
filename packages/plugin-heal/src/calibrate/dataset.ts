/**
 * The labelled case set the classifier is graded against: `heal/triage-cases.json`, committed.
 *
 * A case is the evidence `classify()` consumes plus the class a human says it is. That shape is
 * deliberate — it means calibration runs **offline**: no browser, no model, no network, and no run of
 * the suite. The same property `plugin-ai-judge`'s dataset has, for the same reason: a gate that needs
 * the world to be reachable is a gate that gets disabled.
 *
 * @example
 * loadCases('/repo').cases.filter(entry => entry.expected === 'true-fail');
 */
import fs from 'node:fs';
import path from 'node:path';

import type { TriageClass } from '../triage/classify.js';
import type { ErrorKind } from '../types.js';

export const CASES_PATH = path.join('heal', 'triage-cases.json');

/** Everything `classify()` reads, flattened into something a human can write by hand. */
export interface CaseEvidence {
  /** `TestCase.outcome()` for the run being classified. */
  outcome: 'expected' | 'unexpected' | 'flaky' | 'skipped';
  /** The failure, as the reporter would have recorded it. */
  kind?: ErrorKind;
  matcher?: string;
  locatorCode?: string;
  expectedValue?: string;
  receivedValue?: string;
  message?: string;
  failingStepCategory?: string;
  /** Cross-run history, as measured numbers rather than a recomputation. */
  history?: {
    runs: number;
    flakeRate: number;
    recoveryRate?: number;
    neverPassed?: boolean;
    lastPassed?: string;
  };
  hadGlobalErrors?: boolean;
  testFileChanged?: boolean;
  topFrameFileChanged?: boolean;
  diffUnknown?: boolean;
  infraFileChanged?: boolean;
  configRetries?: number;
}

export interface LabelledCase {
  name: string;
  /** Where the case came from, so a reviewer can go and look. */
  source?: string;
  evidence: CaseEvidence;
  expected: TriageClass;
  /**
   * Substrings that must each appear in one of the classifier's vetoes.
   *
   * The class says what the evidence indicates; a veto decides whether anything may be done about it,
   * and for the cases where a human just edited the code the veto is the whole safety property. Without
   * this field the dataset would grade only the label and never the guard — so a refactor that dropped
   * a veto would pass calibration while making the engine dangerous.
   */
  expectedVetoes?: string[];
  /** Free text: why a human says so. The most valuable field in the file. */
  note?: string;
}

export interface CaseFile {
  version: 1;
  cases: LabelledCase[];
}

const CLASSES = new Set<TriageClass>([
  'flaky',
  'locator-drift',
  'true-fail',
  'env-infra',
  'unknown',
]);

const isCase = (value: unknown): value is LabelledCase => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Partial<LabelledCase>;
  return (
    typeof entry.name === 'string' &&
    entry.name !== '' &&
    typeof entry.evidence === 'object' &&
    entry.evidence !== null &&
    entry.expected !== undefined &&
    CLASSES.has(entry.expected)
  );
};

export interface LoadResult {
  cases: LabelledCase[];
  /** Absent, unparseable, or nothing usable — the caller reports rather than guessing. */
  problem?: string;
}

export function loadCases(projectDir: string, file = CASES_PATH): LoadResult {
  const target = path.isAbsolute(file) ? file : path.join(projectDir, file);
  let raw: string;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch {
    return {
      cases: [],
      problem: `${file} not found — run 'heal calibrate --harvest' to draft one`,
    };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CaseFile>;
    if (!Array.isArray(parsed.cases)) {
      return { cases: [], problem: `${file}: no 'cases' array` };
    }
    const cases = parsed.cases.filter(isCase);
    const dropped = parsed.cases.length - cases.length;
    return {
      cases,
      problem:
        dropped === 0
          ? undefined
          : `${file}: ignored ${dropped} malformed case${dropped === 1 ? '' : 's'}`,
    };
  } catch (error) {
    return {
      cases: [],
      problem: `${file} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

export function saveCases(
  projectDir: string,
  cases: readonly LabelledCase[],
  file = CASES_PATH,
): void {
  const target = path.isAbsolute(file) ? file : path.join(projectDir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ version: 1, cases }, null, 2)}\n`);
}
