/**
 * Classifying every failure in one run. Shared by `heal triage` and `heal propose`, so the two can
 * never disagree about what a failure is — a propose that re-derived the class would eventually
 * repair something triage called a regression.
 *
 * @example
 * const findings = triageRun(projectDir, latest, allRuns);
 * findings.filter(f => f.triage.class === 'locator-drift');
 */
import { flakeStats } from '../history/flakeStats.js';
import type { AttemptRecord, FailureRecord, RunRecord, TestRecord } from '../types.js';
import { classify, type Triage } from './classify.js';
import { changedFiles, touched } from './gitDiff.js';

export interface Finding {
  test: TestRecord;
  /** The failure from the last attempt that actually failed. */
  failure?: FailureRecord;
  triage: Triage;
}

/** The last attempt that failed is the one whose evidence describes the failure. */
export const lastFailure = (attempts: readonly AttemptRecord[]): FailureRecord | undefined =>
  [...attempts].reverse().find(attempt => attempt.failure !== undefined)?.failure;

export interface TriageRunOptions {
  /** How many prior runs to weigh as history. */
  window?: number;
}

export function triageRun(
  projectDir: string,
  run: RunRecord,
  runs: readonly RunRecord[],
  options: TriageRunOptions = {},
): Finding[] {
  const changed = changedFiles(projectDir, run.baseRef);
  const others = runs.filter(candidate => candidate.runId !== run.runId);
  const findings: Finding[] = [];

  for (const test of run.tests) {
    if (test.outcome !== 'unexpected' && test.outcome !== 'flaky') {
      continue;
    }
    const failure = lastFailure(test.attempts);
    const history = flakeStats(others, test.testKey, { window: options.window ?? 20 });
    findings.push({
      test,
      failure,
      triage: classify({
        outcome: test.outcome,
        failure,
        history: history.runs === 0 ? undefined : history,
        hadGlobalErrors: run.globalErrors.length > 0,
        diffUnknown: !changed.known,
        testFileChanged: changed.known ? touched(changed, test.file) : undefined,
        topFrameFileChanged: changed.known ? touched(changed, failure?.topFrame?.file) : undefined,
        infraFileChanged: changed.known
          ? touched(changed, 'package-lock.json') || touched(changed, 'playwright.config.ts')
          : undefined,
        configRetries: run.configRetries,
      }),
    });
  }
  return findings;
}
