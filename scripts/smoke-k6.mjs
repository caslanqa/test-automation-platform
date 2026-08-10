#!/usr/bin/env node
/**
 * Runtime smoke test for the k6 load scenarios `@pwtap/plugin-perf` ships. Run with `npm run smoke:k6`.
 *
 * These templates are shipped CODE that no build covers: `tsc -b` only compiles each package's `src/`, and k6
 * transpiles TypeScript with esbuild, which strips types and verifies none of them. `npm run typecheck:perf-templates`
 * closes the type half; this closes the runtime half. Both defects Phase 2 found — VU pool sizing, and gating
 * `dropped_iterations` in the wrong shapes — were invisible to every static check and only appeared on a real run.
 *
 * It does NOT scaffold a project. The thing under test is the k6 scripts, and all they need is one sibling `env/`
 * directory, because `perf/lib/env.ts` reads `../../env/environments.json` with k6's `open()`. Copying
 * `templates/perf` next to a minimal env file exercises the real resolution path in seconds; a full scaffold would
 * add a browser install and several minutes to verify nothing extra about these files.
 *
 * Four assertions, each one a claim the shipped scripts make:
 *   1. `smoke.ts` runs against a live target and passes its thresholds (exit 0).
 *   2. The run actually did work — see {@link assertDidWork}, which exists because of a bug in this file.
 *   3. Its thresholds actually GATE: the same script against a target returning 500s fails, and fails for the
 *      right reason.
 *   4. An unset `PERF_TARGET_URL` aborts at init, before any request, naming what to set.
 *
 * Skips (exit 0) when the k6 binary is absent, the same way a test skips without a device — so a contributor
 * without k6 is not blocked. CI installs it, so CI runs it.
 *
 * @example
 *   npm run smoke:k6   # prints "[smoke:k6] OK" when the shipped scenarios run, gate, and abort correctly
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const templates = path.join(root, 'packages/plugin-perf/templates/perf');
/** 20 s at roughly a second of think time per iteration, so anything near this proves the target was answering. */
const MINIMUM_ITERATIONS = 5;

if (spawnSync('k6', ['version'], { stdio: 'ignore' }).status !== 0) {
  console.log(
    '[smoke:k6] skipped — the k6 binary is not runnable (brew install k6, or see the plugin docs).',
  );
  process.exit(0);
}

/**
 * A target that answers every request the same way.
 *
 * `status` is fixed rather than random: a run that fails half the time is not a check, and the gating assertion
 * below needs a failure it can rely on.
 */
async function startTarget(status) {
  const server = http.createServer((_request, response) => {
    response.statusCode = status;
    response.end(status < 400 ? 'ok' : 'boom');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, stop: () => server.close() };
}

/** A copy of the shipped scenarios, with the one sibling directory `lib/env.ts` expects. */
function stageScenarios(targetUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-k6-'));
  fs.cpSync(templates, path.join(dir, 'perf'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'env'));
  fs.writeFileSync(
    path.join(dir, 'env/environments.json'),
    // PERF_TARGET_URL sits in the environment block, not in `common` — the arrangement the docs ask for, so this
    // exercises the block-wins-over-common merge as well as the plain read.
    `${JSON.stringify(
      {
        common: { DEFAULT_TEST_ENV: 'dev', PERF_TARGET_URL: '' },
        environments: { dev: { PERF_TARGET_URL: targetUrl } },
      },
      null,
      2,
    )}\n`,
  );
  return dir;
}

/**
 * Run k6 and collect its output.
 *
 * Asynchronous, and that is not a style choice: the target above lives in THIS process, and `spawnSync` blocks the
 * event loop, so a synchronous k6 run cannot be served by it. The first version of this file used `spawnSync` and
 * every run therefore completed zero iterations — which k6 exits 0 for, because a threshold over an empty metric
 * passes. The check reported OK while verifying nothing at all.
 */
function runK6(dir, script, env = {}) {
  return new Promise(resolve => {
    const child = spawn('k6', ['run', `perf/${script}`], {
      cwd: dir,
      env: { ...process.env, ...env },
    });
    let output = '';
    child.stdout.on('data', chunk => (output += chunk));
    child.stderr.on('data', chunk => (output += chunk));
    child.on('close', status => resolve({ status, output }));
  });
}

function assert(condition, message, output) {
  if (!condition) {
    console.error(output ?? '');
    throw new Error(`[smoke:k6] ${message}`);
  }
}

/**
 * Did the run actually do anything?
 *
 * The load-bearing assertion, and the one this file was missing. An exit code of 0 does not mean a scenario worked:
 * k6 evaluates `http_req_failed: ['rate<0.01']` over the requests that happened, so **zero requests passes**. A
 * staging mistake, an unreachable target, a journey that throws before its first call — all of them exit 0 and look
 * green. Counting iterations is what separates "passed" from "did nothing".
 */
function assertDidWork(run, label) {
  const iterations = Number(/iterations[.\s]*:\s*(\d+)/.exec(run.output)?.[1] ?? 0);
  assert(
    iterations >= MINIMUM_ITERATIONS,
    `${label} completed only ${iterations} iterations (expected at least ${MINIMUM_ITERATIONS}) — ` +
      'the run exited without doing the work, so its thresholds passed over an empty metric',
    run.output,
  );
  return iterations;
}

const healthy = await startTarget(200);
const staged = stageScenarios(healthy.url);
try {
  console.log(`[smoke:k6] running the shipped smoke scenario against ${healthy.url}…`);
  const passing = await runK6(staged, 'smoke.ts');
  assert(
    passing.status === 0,
    `smoke.ts failed against a healthy target (exit ${passing.status})`,
    passing.output,
  );
  assert(
    passing.output.includes(healthy.url),
    'smoke.ts did not report the target from env/environments.json — the env block may not be resolving',
    passing.output,
  );
  console.log(`[smoke:k6]   ${assertDidWork(passing, 'smoke.ts')} iterations, thresholds green.`);

  // A threshold that cannot fail is decoration. `smoke.ts` gates `http_req_failed` and `checks`, so a target that
  // answers 500 to everything must take the run non-zero — and for that reason, not some unrelated one.
  console.log('[smoke:k6] checking the thresholds actually gate, against a target returning 500s…');
  const failing = await startTarget(500);
  const staged500 = stageScenarios(failing.url);
  try {
    const breached = await runK6(staged500, 'smoke.ts');
    assertDidWork(breached, 'the 500-target run');
    assert(
      breached.status !== 0,
      'smoke.ts PASSED against a target returning 500 to everything — its thresholds are not gating',
      breached.output,
    );
    assert(
      /thresholds on metrics.*(http_req_failed|checks)/.test(breached.output),
      'the 500-target run failed, but not on http_req_failed or checks — something else broke',
      breached.output,
    );
  } finally {
    failing.stop();
    fs.rmSync(staged500, { recursive: true, force: true });
  }

  // The guard that keeps a load test off a service nobody chose. It must fail before any request is sent.
  console.log('[smoke:k6] checking an unset PERF_TARGET_URL aborts at init…');
  const unset = await runK6(staged, 'smoke.ts', {
    PERF_TARGET_URL: '',
    TEST_ENV: 'nonexistent-env',
  });
  assert(unset.status !== 0, 'an unset PERF_TARGET_URL did not fail the run', unset.output);
  assert(
    unset.output.includes('PERF_TARGET_URL is not set'),
    'the unset-target failure did not name PERF_TARGET_URL',
    unset.output,
  );

  console.log(
    '\n[smoke:k6] OK — the shipped k6 scenarios run, their thresholds gate, and an unset target aborts.',
  );
} finally {
  healthy.stop();
  fs.rmSync(staged, { recursive: true, force: true });
}
