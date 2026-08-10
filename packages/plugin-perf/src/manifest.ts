/**
 * `@pwtap/create` injection manifest for the performance plugin — two layers, injected together.
 *
 * **Layer 1** (`tests/perf`, the `vitals`/`budget`/`bench` fixtures) is shaped like `db` and `ai-judge`, not like
 * the mobile plugins: no env-gated Playwright project, because these fixtures measure the page a test already
 * opened. They merge into `@fixtures` and need no gate — a budget that cannot be measured skips on its own.
 *
 * **Layer 2** (`perf/`, the k6 scenarios) is not a Playwright anything. k6 has its own runtime and its own binary,
 * and load runs alone on the machine, so it arrives as scripts plus `perf:*` npm commands. Nothing in `dist/`
 * imports k6, and it is not an npm dependency; `ensure` reports the missing binary by name.
 *
 * **One env key, `PERF_TARGET_URL`.** Layer 1 needs none — budgets are numbers that belong in a versioned spec
 * (an LCP ceiling is part of the test, not part of the deployment) and `bench` resolves against Playwright's own
 * `baseURL`. Layer 2 is the opposite case: WHICH deployment to put under load is deployment configuration, and it
 * must be stated rather than inherited, so nothing quietly loads a public demo service.
 *
 * @example
 * test.use({ perfBudget: { lcp: 2500, totalBytes: 1_500_000, bench: { p99: 800, errorRate: 0 } } });
 */
export const manifest = {
  id: 'perf',
  name: '@pwtap/plugin-perf',
  devDependencies: {
    // Types only, for `typecheck:perf`. k6 itself strips types without checking them, so this is what makes the
    // `perf/` directory more than untyped JavaScript wearing a .ts extension.
    '@types/k6': '^2.0.1',
  },
  scripts: {
    // Layer 1. The budgets are stable enough to gate, but only when the machine is not also running other
    // workers — `bench` shares the pool with everything else, so a quoted percentile needs a pool of one.
    'test:perf': 'playwright test tests/perf --workers=1',
    // Layer 2. Smoke first, always: a load test whose journey is broken reports a fast, wrong number.
    'perf:smoke': 'k6 run perf/smoke.ts',
    'perf:load': 'k6 run perf/load.ts',
    'perf:stress': 'k6 run perf/stress.ts',
    'perf:spike': 'k6 run perf/spike.ts',
    'perf:soak': 'k6 run perf/soak.ts',
    'typecheck:perf': 'tsc -p perf/tsconfig.json',
  },
  envKeys: {
    // Injected under `common` empty on purpose: a load target belongs to ONE deployment, so move it into the
    // `environments.<env>` block you mean. Empty means every k6 scenario aborts at init with that instruction.
    PERF_TARGET_URL: '',
  },
  fixture: {
    importFrom: '@pwtap/plugin-perf',
    test: { export: 'test', alias: 'perfTest' },
  },
  examples: [
    { src: 'templates/tests', dest: 'tests/perf' },
    { src: 'templates/perf', dest: 'perf' },
  ],
  docs: [{ src: 'docs/PERF_TESTING.md', dest: 'docs/PERF_TESTING.md' }],
  ensure: 'ensure',
  readmeSection: [
    '## Performance',
    '',
    'Two layers with a hard line between them. **Layer 1** asserts single-user performance inside the suite you',
    'already have — Core Web Vitals, resource budgets, one endpoint’s latency percentiles. **Layer 2** is load',
    'testing with k6: ramp shapes, arrival-rate models and thresholds, run as its own command outside the',
    'Playwright runner, because a load generator inside a parallel worker pool measures the worker pool.',
    '',
    '### Layer 1 — in the suite',
    '',
    '**1. Put the numbers in `perfBudget`**, once per file, so each spec reads as intent rather than as a list of',
    'magic constants:',
    '',
    '```ts',
    'test.use({ perfBudget: { lcp: 2500, cls: 0.1, totalBytes: 1_500_000, requests: 60 } });',
    '```',
    '',
    '**2. `vitals`** reads the page’s own performance timeline — `ttfb`, `fcp`, `lcp`, `cls`, `inp`, `tbt`,',
    '`longTasks`, `domContentLoaded`, `load`. Collect after the page is in the state you want measured:',
    '`await page.goto("/"); await vitals.assert();`. Measured on Playwright’s own builds, everything except',
    '**`cls`, `tbt` and `longTasks`** is reported by Chromium, WebKit and Firefox alike; those three need',
    '`layout-shift`/`longtask` entries, so a budget naming them SKIPS outside Chromium instead of failing.',
    '',
    '**3. `budget`** counts real transfer size from Playwright’s own `requestfinished` event, so it needs no CDP',
    'session: `await budget.assert()` checks `totalBytes`, `requests` and `byType`, and a breach names the largest',
    'resources so nobody has to open the network tab to find out which dependency grew.',
    '',
    '**4. `bench`** benchmarks one endpoint with autocannon: `await bench.run({ path: "/api/health" })` →',
    '`{ p50, p90, p97_5, p99, rps, errors, non2xx, errorRate }`. `path` resolves against `baseURL`. There is no',
    '`p95` because autocannon’s histogram has no p95 bucket, and interpolating one would be inventing a number.',
    '',
    '**`bench` is a budget check, not a load test.** It runs in the shared worker pool, so use `npm run test:perf`',
    '(`--workers=1`) before quoting any figure, and always gate `errorRate` next to a latency threshold — a fast',
    'run that rejects half its requests is not a fast run.',
    '',
    '**5. Read the result.** A breached budget FAILS and names the culprit. A budget that could not be measured —',
    'an unreachable endpoint, a metric this browser does not implement, an INP budget in a test that never',
    'interacted — **skips** with the reason, the same way an absent device or database does.',
    '',
    '### Layer 2 — load, with k6',
    '',
    '**1. Install the binary** (`brew install k6`, or see grafana.com/docs/k6). It is not an npm package: k6 runs',
    'its own JavaScript runtime, not Node. `create-pwtap add perf` warns if it is missing.',
    '',
    '**2. Name the target.** Set `PERF_TARGET_URL` inside the `environments.<env>` block you mean — not under',
    '`common`, because a load target belongs to one deployment. There is no fallback to `BASE_URL` or',
    '`API_BASE_URL` on purpose: inheriting them is how a laptop ends up sending 200 requests a second at a public',
    'demo service. Unset, every scenario aborts at init and says this.',
    '',
    '**3. Edit `perf/lib/flow.ts`.** All five shapes import that one `journey()` function, so the ramps stay',
    'separate from what a virtual user does. A load journey is usually not your Playwright test rewritten — model',
    'the HTTP calls underneath a user journey, with correlation and think time.',
    '',
    '**4. Run smoke first, always:** `npm run perf:smoke` (one VU, 20 s). Then `perf:load` (expected peak),',
    '`perf:stress` (past peak until something breaks), `perf:spike` (surge **and** recovery), `perf:soak`',
    '(nightly, 30 min). Thresholds live in each script’s `options`, so the gate is versioned with the scenario and',
    'k6 sets the exit code itself — no wrapper interprets output.',
    '',
    '**5. `npm run typecheck:perf`.** k6 strips TypeScript without checking it, so without this the directory is',
    'untyped JavaScript wearing a `.ts` extension. Wire it into CI next to `type-check`.',
    '',
    'Every load script gates `dropped_iterations`, which counts iterations k6 could not start on schedule: it fails',
    'the run when your GENERATOR was the bottleneck rather than the target. A saturated laptop otherwise reports',
    'excellent latency, and that number is a lie.',
    '',
    'Full guide, including which metric needs which browser, how to read each skip, and what to gate in CI versus',
    'nightly: `docs/PERF_TESTING.md`.',
  ].join('\n'),
} as const;
