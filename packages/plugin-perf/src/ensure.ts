/**
 * Advisory checks after `create-pwtap add perf` — hints, never failures.
 *
 * Two things can genuinely be missing, and both surface at the worst possible moment otherwise: `autocannon` as a
 * module error inside the first `bench.run`, and the k6 binary as a shell "command not found" from an npm script.
 *
 * Layer 1 needs nothing else: budgets live in the spec and `bench` takes its target from Playwright's own
 * `baseURL`, so there is no env key to get half-right. Layer 2's one key, `PERF_TARGET_URL`, is deliberately NOT
 * warned about here — it is empty in a fresh scaffold by design, and every k6 scenario already aborts at init with
 * the full instruction. A warning at install time for the expected state is how `ensure` output gets ignored.
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function ensure(): Promise<void> {
  const warn = (message: string): void => console.warn(`⚠ [perf] ${message}`);

  const require = createRequire(`${process.cwd()}/`);
  try {
    require.resolve('autocannon');
  } catch {
    warn(
      'autocannon is not resolvable from this project, so the `bench` fixture cannot run — ' +
        'reinstall dependencies (npm install), or npm i -D autocannon',
    );
  }

  // k6 is an external binary, like the Maestro CLI: nothing in this package imports it, and it is not an npm
  // dependency, because k6 does not run on Node.
  try {
    await run('k6', ['version']);
  } catch {
    warn(
      'the k6 binary is not on PATH, so the load scripts in perf/ cannot run — ' +
        'brew install k6 (macOS), or see https://grafana.com/docs/k6/latest/set-up/install-k6/. ' +
        'The Layer 1 fixtures (vitals, budget, bench) do not need it.',
    );
  }
}
