/**
 * Verifying a candidate by running it.
 *
 * Three rules, each of which is a way a "verified" heal can be worthless:
 *
 * - **`--retries=0` is mandatory.** A heal validated by a retry is not validated: the retry is what
 *   would have hidden the flake this heal is not supposed to be fixing.
 * - **Three consecutive greens under `--workers=1`, then the whole file at the configured
 *   concurrency.** Same-worker repetition catches state carried between attempts; the parallel
 *   full-file run catches order dependence and shared-fixture contention. A candidate that is green
 *   only serially is not a fix.
 * - **The original assertion must still have run.** A replacement that makes the test vacuous — a
 *   locator that quietly satisfies a `test.skip` condition, or an assertion that no longer executes —
 *   passes every other check. The matcher that failed has to reappear as a step in a green attempt.
 *   That is measured through our own reporter, not the JSON one: **the JSON reporter emits `steps: []`
 *   for a passing test**, so the check would be permanently unreachable through it.
 *
 * `HEAL_GREENS` is a knob rather than a constant because the right number depends on how flaky the
 * suite already is, which cannot be known from here.
 *
 * @example
 * await verifyCandidate({ projectDir, file: 'tests/a.spec.ts', title: 'shows the total', project: 'chromium' });
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseVerifyOutput } from './verifyReporter.js';

/** Default consecutive green runs required. Not 1 (proves nothing about order or timing), not 10. */
export const DEFAULT_GREENS = 3;

export interface RerunTarget {
  projectDir: string;
  /** Spec path relative to the project. */
  file: string;
  /** The test title, used with `-g`. */
  title: string;
  /** Playwright project name; omitted for a config with no named projects. */
  project?: string;
  greens?: number;
  /** Extra environment for the run — the smoke uses it to pin the fixture app version. */
  env?: Record<string, string>;
  /**
   * Tests in this file that were ALREADY failing before the edit, by title.
   *
   * Without this the whole-file check refuses every repair made while a sibling is red for an
   * unrelated reason — which is most real repair sessions. What it has to detect is a candidate that
   * *broke* something, so the comparison is against this baseline rather than against green.
   */
  alreadyFailing?: readonly string[];
}

export interface RerunAttempt {
  label: string;
  args: string[];
  code: number;
  stdout: string;
  stderr: string;
}

export interface RerunResult {
  ok: boolean;
  greens: number;
  /** Tests that failed alongside the candidate and were not already failing before it. */
  newlyBroken: string[];
  /** True when the matcher that originally failed appears as a passing step in a green run. */
  assertionRan: boolean;
  attempts: RerunAttempt[];
  reasons: string[];
}

/** The compiled verification reporter, resolved from this module so it works from any cwd. */
export const verifyReporterPath = (): string =>
  fileURLToPath(new URL('./verifyReporter.js', import.meta.url));

/** Escape a title for Playwright's `-g`, which takes a regular expression. */
export const escapeTitle = (title: string): string => title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function run(
  projectDir: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(
      'npx',
      ['playwright', 'test', ...args],
      {
        cwd: projectDir,
        encoding: 'utf8',
        env: { ...process.env, ...env },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        resolve({ code: (error as { code?: number } | null)?.code ?? 0, stdout, stderr }),
    );
  });
}

/**
 * Run the single test `greens` times serially, then its whole file in parallel.
 *
 * `assertionRan` is read from the JSON reporter rather than from stdout: a matcher name in a list
 * reporter's output is not evidence that the assertion executed, only that the test did.
 */
export async function verifyCandidate(target: RerunTarget, matcher?: string): Promise<RerunResult> {
  const greensWanted = target.greens ?? Number(process.env.HEAL_GREENS ?? DEFAULT_GREENS);
  const attempts: RerunAttempt[] = [];
  const reasons: string[] = [];
  const projectArgs = target.project === undefined ? [] : [`--project=${target.project}`];
  const posixFile = target.file.split(path.sep).join('/');
  const env = { ...target.env, HEAL_PROBE: '' };

  // Serial repetition, retries off. `--repeat-each` keeps it one invocation rather than N.
  const serial = await run(
    target.projectDir,
    [
      posixFile,
      '-g',
      escapeTitle(target.title),
      ...projectArgs,
      '--retries=0',
      '--workers=1',
      `--repeat-each=${greensWanted}`,
      `--reporter=${verifyReporterPath()}`,
    ],
    env,
  );
  attempts.push({
    label: `serial x${greensWanted}`,
    args: ['--repeat-each', String(greensWanted)],
    ...serial,
  });

  const parsed = parseVerifyOutput(serial.stdout);
  const greens = parsed.filter(result => result.status === 'passed').length;
  if (greens < greensWanted) {
    reasons.push(
      `only ${greens} of ${greensWanted} serial runs passed — a candidate that is not consistently green is not a fix`,
    );
  }
  // A skipped result is not a green: a replacement that makes a `test.skip` condition fire would
  // otherwise look like a pass.
  const skipped = parsed.filter(result => result.status === 'skipped').length;
  if (skipped > 0) {
    reasons.push(`${skipped} run(s) were skipped — a skip is not a pass`);
  }

  const assertionRan =
    matcher === undefined
      ? parsed.length > 0
      : parsed.some(result => result.status === 'passed' && result.matchers.includes(matcher));
  if (!assertionRan) {
    reasons.push(
      `the assertion that failed (${matcher ?? 'unknown'}) did not run in the green attempts — the replacement may have made the test vacuous`,
    );
  }

  // The whole file at the configured concurrency: order dependence and fixture contention only show
  // up when the neighbours run too.
  const parallel = await run(
    target.projectDir,
    [posixFile, ...projectArgs, '--retries=0', `--reporter=${verifyReporterPath()}`],
    env,
  );
  attempts.push({ label: 'whole file, configured workers', args: [posixFile], ...parallel });
  const baseline = new Set(target.alreadyFailing ?? []);
  const newlyBroken = [
    ...new Set(
      parseVerifyOutput(parallel.stdout)
        .filter(result => result.status === 'failed' || result.status === 'timedOut')
        .map(result => result.title)
        .filter(title => title !== '' && title !== target.title && !baseline.has(title)),
    ),
  ];
  if (newlyBroken.length > 0) {
    reasons.push(
      `the candidate broke ${newlyBroken.length} test(s) that were not failing before it: ${newlyBroken.join(', ')}`,
    );
  }

  return {
    ok: greens >= greensWanted && skipped === 0 && assertionRan && newlyBroken.length === 0,
    greens,
    newlyBroken,
    assertionRan,
    attempts,
    reasons,
  };
}
