# @pwtap/plugin-perf

Performance testing for the [Playwright Test Automation Platform](https://www.npmjs.com/package/@pwtap/create) —
Core Web Vitals, resource budgets and endpoint latency percentiles, asserted inside the suite you already have.

[![npm](https://img.shields.io/npm/v/@pwtap/plugin-perf)](https://www.npmjs.com/package/@pwtap/plugin-perf)

| Fixture  | You get                                                          | Needs           |
| -------- | ---------------------------------------------------------------- | --------------- |
| `vitals` | `ttfb fcp lcp cls inp tbt longTasks domContentLoaded load`       | a page          |
| `budget` | real transfer bytes and request counts, overall and per type     | a page          |
| `bench`  | `p50 p90 p97_5 p99 rps errors non2xx errorRate` for one endpoint | a URL listening |

That table is **Layer 1**: assertions about one user, riding along with tests you already run. It catches the
regression that actually happens — a 400 KB dependency, an endpoint that got slower — and needs no load
generator, no external binary and no environment variables.

**Layer 2** is load testing with k6 — five ramp shapes, arrival-rate models, thresholds that set the exit code —
run as its own command outside the Playwright runner, because a load generator inside a parallel worker pool
measures the worker pool. See §6 below.

## 1. Install

```bash
npx create-pwtap add perf
```

Nothing else. `autocannon` ships with the plugin; there is no driver to pick and no binary to install.

## 2. Configure

Budgets go in the spec, not in `env/environments.json` — an LCP ceiling is part of the test, not part of the
deployment:

```ts
import { expect, test } from '@fixtures';

test.use({
  perfBudget: {
    lcp: 2500,
    cls: 0.1,
    ttfb: 800,
    totalBytes: 1_500_000,
    requests: 60,
    byType: { script: 400_000 },
    bench: { p99: 800, errorRate: 0, connections: 10, amount: 500 },
  },
});
```

**Measure before choosing numbers.** Run `collect()`, read the output, set the ceiling just above what you will
accept. A budget nobody can breach is documentation, not a test.

## 3. Write

```ts
test('the product page stays within budget', async ({ page, vitals, budget }) => {
  await page.goto('/products/42', { waitUntil: 'load' });
  await vitals.assert(); // checks perfBudget's vitals keys
  await budget.assert(); // checks totalBytes / requests / byType
});

test('the health endpoint is fast', async ({ bench }) => {
  const result = await bench.assert({ path: '/api/health' });
  expect(result.errorRate).toBe(0);
});
```

Every fixture has `collect()` (or `run()`, for `bench`) to measure without asserting, and `assert()` to check
against `perfBudget`. `assert()` returns what it measured, so a spec can add its own checks.

## 4. Run

```bash
npm run test:perf   # tests/perf with --workers=1
```

`--workers=1` matters for `bench`: it runs inside a Playwright worker, so a percentile measured while five
browsers are alive is a number about your machine. `vitals` and `budget` do not care.

## 5. Read the result

Every fixture writes what it measured into the run — a one-line annotation next to the test, and the full
measurement as an attachment (`perf-vitals.json`, `perf-resources.json`, `perf-bench.json`), **including when the
test failed**:

```
perf:vitals     lcp 512ms · cls 0.002 · ttfb 128ms · fcp 388ms
perf:resources  9 requests · 249 kB (script 169 kB, font 67 kB, stylesheet 11 kB)
perf:bench      p50 1.2ms · p97.5 3ms · p99 12ms · 850 req/s · 0.00% errors
```

`perf-resources.json` lists every request with its transfer size, which answers "what grew" without re-running with
the network tab open. `npx playwright show-report` to browse, `test-results/results.json` to track a trend.

A breached budget **fails** and names the culprit:

```
[perf] resource budget exceeded:
  - total transfer 1.72 MB exceeds the 1.50 MB budget — largest: script https://app/vendor.js (900 kB), …
```

A budget that could not be measured **skips** with the reason, the same way an absent device or an unreachable
database does: an endpoint with nothing listening, an `inp` budget in a test that never interacted, or a metric
this browser does not implement. Measured on Playwright 1.61's own builds: `ttfb`, `domContentLoaded`, `load`,
`fcp`, `lcp` and `inp` are reported by **Chromium, WebKit and Firefox alike** — only `cls`, `tbt` and `longTasks`
need `layout-shift`/`longtask` entries and are Chromium-only. Support is read at run time, so the skip always names
the entry type that was actually missing.

Two exceptions, on purpose: `assert()` with an empty budget throws (a budget that checks nothing would pass
forever), and a real breach beats an unmeasurable metric (skipping would hide the breach).

## 6. Layer 2 — load, with k6

```bash
brew install k6           # macOS. apt/dnf/winget/choco, Docker and standalone binaries all work too —
                          # there is no npm route: k6 runs its own JS runtime, not Node
npm run perf:smoke        # 1 VU, 20s — run this first, always
npm run perf:load         # ramp to your expected peak, hold, ramp down
npm run perf:stress       # past peak until something breaks
npm run perf:spike        # 5× surge, then a quiet window that must recover
npm run perf:soak         # 30 minutes, nightly — does it leak?
npm run typecheck:perf    # k6 strips types without checking them; this checks them
```

`create-pwtap add perf` installs nothing, but it probes this machine for `brew`/`apt-get`/`dnf`/`yum`/`winget`/
`choco` and prints the command that actually fits — or, finding none, the standalone binary and Docker routes. A
hardcoded `brew install k6` is wrong on every Linux CI runner.

**Name the target first.** Set `PERF_TARGET_URL` in the `environments.<env>` block you mean — not under `common`,
because a load target belongs to one deployment. There is no fallback to `BASE_URL`/`API_BASE_URL` on purpose:
inheriting them is how a laptop ends up loading a public demo service. Unset, every scenario aborts at init and
says so.

**Then edit `perf/lib/flow.ts`.** All five shapes import its one `journey()` function, so the ramps stay separate
from what a virtual user does. A load journey is usually not your Playwright test rewritten — model the HTTP calls
underneath a user journey, with correlation and think time.

Thresholds live in each script's `options`, so the gate is versioned with the scenario and k6 sets the exit code
itself (a breach exits 99). `load.ts` and `soak.ts` gate **`dropped_iterations`** — iterations k6 could not start
on schedule — which is the check that stops a run lying to you: starving the VU pool on purpose produced
`p(99)=11ms` and `0.00%` errors while dropping 1071 iterations. If it fails, raise `preAllocatedVUs` (sized by
`vusFor()`), don't delete the threshold.

## Notes

- **No `p95`.** autocannon's histogram has p50, p75, p90, p97_5 and p99 buckets. Interpolating a p95 to match a
  nicer-sounding name would be inventing a number.
- **`cls` is the worst 5-second session window**, not the sum of every shift, and excludes shifts the user caused.
  **`inp` is the worst interaction**, grouping entries by `interactionId`. Both follow the metric definitions
  rather than an approximation, and both are unit tested.
- **`budget.collect()` waits for the network to go quiet** (2 s by default, `collect({ settleMs })` to change it).
  A page keeps loading after `load`: measured on one real page, 4 requests and 181 kB at `load` against 9 requests
  and 249 kB once quiet — and a clicked route read immediately reported **0 requests** with 6 images still in flight.
- **No `web-vitals` dependency and no Lighthouse.** The page already ships the measurement; a Lighthouse score
  moves when Chrome updates, which makes it a poor CI gate.

Full guide, including every skip message and what to do about it: `docs/PERF_TESTING.md`.
