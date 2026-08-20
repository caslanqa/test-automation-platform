/**
 * `heal triage --confirm-flake` — measure flakiness instead of inferring it.
 *
 * **Why this exists.** The engine's strongest flake signal is `TestCase.outcome() === 'flaky'`, which
 * only exists when a retry ran. The core scaffold sets `retries: process.env.CI ? 2 : 0`, so **locally
 * there is no in-run flake signal at all** — and the mobile plugins differ from each other again
 * (`plugin-appium` sets `retries: 1` on its project, `plugin-maestro` does not).
 *
 * The tempting fix is for the heal manifest to raise `retries`. It must not: that is the user's config,
 * and silently doubling every local run's wall-clock to serve a diagnostic is not a trade anyone asked
 * for. So the answer is a deliberate, opt-in probe — run the one test N times with retries **off** and
 * report what actually happened. `retries: 0` is the correct setting for a suite that wants
 * reproducibility; this is what makes that setting cost nothing in diagnosis.
 *
 * @example
 * await confirmFlake({ projectDir, file: 'tests/a.spec.ts', title: 'shows an error' });
 * // → { runs: 5, passed: 3, failed: 2, verdict: 'flaky' }
 */
import { execFile } from 'node:child_process';
import { escapeTitle } from './rerun.js';

/** How many times to run it. Five is enough to see a coin-flip and short enough to sit through. */
export const DEFAULT_PROBE_RUNS = 5;

export interface ConfirmFlakeTarget {
  projectDir: string;
  file: string;
  title: string;
  project?: string;
  runs?: number;
  env?: Record<string, string>;
}

export interface ConfirmFlakeResult {
  runs: number;
  passed: number;
  failed: number;
  /** `flaky` when it did both, `consistent-pass`/`consistent-fail` when it did one. */
  verdict: 'flaky' | 'consistent-pass' | 'consistent-fail';
  /** Exit code per attempt, in order, so a pattern (first-run-only) is visible rather than averaged. */
  codes: number[];
  /**
   * The first failing attempt's output, trimmed.
   *
   * Carried because a probe that reports "it fails every time" without saying why sends the reader back
   * to run the command themselves — and the most common cause of an unexpected `consistent-fail` is that
   * the probe's own environment was missing something the suite needs, which this makes obvious.
   */
  firstFailureOutput?: string;
}

function once(
  target: ConfirmFlakeTarget,
  args: string[],
): Promise<{ code: number; output: string }> {
  return new Promise(resolve => {
    execFile(
      'npx',
      ['playwright', 'test', ...args],
      {
        cwd: target.projectDir,
        encoding: 'utf8',
        env: { ...process.env, ...target.env },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        resolve({
          code: (error as { code?: number } | null)?.code ?? 0,
          output: `${stdout}${stderr}`,
        }),
    );
  });
}

/**
 * Run one test repeatedly with retries off.
 *
 * **Serially, and in separate processes.** `--repeat-each` would run the copies inside one process,
 * where module state persists — and module state is exactly what a first-run-only failure is made of.
 * A separate process per attempt is what makes the answer mean anything.
 */
export async function confirmFlake(target: ConfirmFlakeTarget): Promise<ConfirmFlakeResult> {
  const runs = target.runs ?? DEFAULT_PROBE_RUNS;
  const args = [
    target.file,
    '-g',
    escapeTitle(target.title),
    '--retries=0',
    '--workers=1',
    '--reporter=line',
    ...(target.project === undefined ? [] : [`--project=${target.project}`]),
  ];

  const codes: number[] = [];
  let firstFailureOutput: string | undefined;
  for (let attempt = 0; attempt < runs; attempt += 1) {
    const result = await once(target, args);
    codes.push(result.code);
    if (result.code !== 0 && firstFailureOutput === undefined) {
      firstFailureOutput = result.output.trim().split('\n').slice(-25).join('\n');
    }
  }

  const passed = codes.filter(code => code === 0).length;
  const failed = codes.length - passed;
  return {
    runs: codes.length,
    passed,
    failed,
    verdict:
      passed > 0 && failed > 0 ? 'flaky' : failed === 0 ? 'consistent-pass' : 'consistent-fail',
    codes,
    firstFailureOutput,
  };
}
