/**
 * A reporter used only by `heal propose`'s verification runs.
 *
 * It exists because of a measured limitation: **the JSON reporter emits `steps: []` for a passing
 * test.** So "did the assertion that failed actually run in the green attempt?" — the check that
 * catches a replacement which quietly made the test vacuous — is unanswerable from JSON. The Reporter
 * API does carry those steps (`expect|Expect "toBeVisible" locator('#b')`), and this is the smallest
 * thing that surfaces them.
 *
 * One line per test result, machine-readable, on stdout. Nothing else, so a caller can parse it
 * without stripping a runner's decoration.
 *
 * @example
 * // __HEAL__ {"title":"shows the total","status":"passed","matchers":["toHaveText"]}
 */
import type { Reporter, TestCase, TestResult, TestStep } from '@playwright/test/reporter';

/** Prefix that marks a line as ours, so unrelated output cannot be mistaken for a result. */
export const VERIFY_PREFIX = '__HEAL__ ';

export interface VerifyLine {
  title: string;
  status: string;
  retry: number;
  /** Matcher names from `Expect "<matcher>" …` step titles, in order. */
  matchers: string[];
}

/** `Expect "toBeVisible" locator('#b')` → `toBeVisible`. */
const matcherOf = (title: string): string | undefined => /^Expect "([^"]+)"/.exec(title)?.[1];

class HealVerifyReporter implements Reporter {
  onTestEnd(test: TestCase, result: TestResult): void {
    const matchers: string[] = [];
    const walk = (steps: readonly TestStep[]): void => {
      for (const step of steps) {
        const matcher = matcherOf(step.title);
        if (matcher !== undefined) {
          matchers.push(matcher);
        }
        walk(step.steps);
      }
    };
    walk(result.steps);
    const line: VerifyLine = {
      title: test.title,
      status: result.status,
      retry: result.retry,
      matchers,
    };
    process.stdout.write(`${VERIFY_PREFIX}${JSON.stringify(line)}\n`);
  }

  printsToStdio(): boolean {
    // Our lines ARE the output, so claim the terminal: otherwise Playwright adds a default reporter
    // alongside and the caller has to filter its decoration back out.
    return true;
  }
}

export default HealVerifyReporter;

/** Read the lines this reporter wrote out of a run's stdout. */
export function parseVerifyOutput(stdout: string): VerifyLine[] {
  const lines: VerifyLine[] = [];
  for (const raw of stdout.split('\n')) {
    if (!raw.startsWith(VERIFY_PREFIX)) {
      continue;
    }
    try {
      lines.push(JSON.parse(raw.slice(VERIFY_PREFIX.length)) as VerifyLine);
    } catch {
      continue;
    }
  }
  return lines;
}
