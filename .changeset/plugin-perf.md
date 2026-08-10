---
'@pwtap/create': minor
---

Add `@pwtap/plugin-perf` — non-functional testing, both layers

Core Web Vitals, resource budgets and endpoint latency percentiles, asserted inside the suite you already have.
Three fixtures and one option (`perfBudget`); no environment variables, no external binary, no
`web-vitals` dependency.

- `vitals` reads the page's own performance timeline: `ttfb fcp lcp cls inp tbt longTasks domContentLoaded load`.
  Support is read at run time from `PerformanceObserver.supportedEntryTypes`, so a metric this browser cannot
  produce **skips with the reason** rather than failing on an undefined number. Measured on Playwright's own
  builds: only `cls`, `tbt` and `longTasks` are Chromium-only — `lcp` and `inp`, routinely described as
  Chromium-only, came back from WebKit and Firefox too.
- `budget` counts real transfer size from Playwright's `requestfinished` event and `request.sizes()`, so it needs
  no CDP session. A breach names the largest resources, largest first — a budget failure that does not name the
  culprit is a puzzle, not a report.
- `bench` benchmarks one endpoint with autocannon, resolving `path` against Playwright's own `baseURL`. It reports
  `p97_5` and **not `p95`**: autocannon's histogram has no p95 bucket, and interpolating one to match a
  nicer-sounding name would be inventing a number.

Two algorithms follow the metric definitions rather than an approximation that looks close, and are unit tested:
`cls` is the **worst 5-second session window** (sessions split after a 1 s gap), excluding shifts the user caused —
a sum of every shift over-reports any long-lived page; and `inp` is the **worst interaction**, grouping entries by
`interactionId`, which under 50 interactions is exactly the spec's definition. Both live in Node rather than
inside the `page.evaluate` string, which is what makes them testable at all — the in-page half only harvests raw
entries.

Same contract as every other plugin: a breached budget fails and names the culprit, a budget that cannot be
measured skips with the reason. A real breach wins over an unmeasurable metric, because skipping would hide it,
and `assert()` with an empty budget throws instead of passing forever.

`bench` runs inside a Playwright worker, so the scaffolded `test:perf` script pins `--workers=1` and the docs say
why: a percentile measured while five browsers are alive is a number about your machine.

**Layer 2 is load testing with k6**, and it runs outside the Playwright runner because a load generator inside a
parallel worker pool measures the worker pool. `perf/` gets five shapes — smoke, load, stress, spike, soak — sharing
one `journey()` in `perf/lib/flow.ts`, plus `perf:*` commands and `typecheck:perf`. k6 is an external binary, not an
npm dependency (it runs its own JavaScript runtime); `ensure` names it when it is missing. Thresholds live in each
script's own `options`, so the gate is versioned with the scenario and k6 sets the exit code itself — nothing wraps
it to interpret output.

Three decisions in that layer are worth stating because they are easy to get backwards:

- **`PERF_TARGET_URL` has no fallback.** Not to `BASE_URL`, not to `API_BASE_URL`. Those point at whatever the
  functional suite uses — in a fresh scaffold, public demo services — and inheriting them is how a laptop ends up
  sending 200 requests a second at a site nobody agreed to. Unset, every scenario aborts at init.
- **`dropped_iterations` is gated in `load.ts`/`soak.ts` and deliberately not in `stress.ts`/`spike.ts.`** It counts
  iterations k6 could not start on schedule, which happens both when the VU pool is too small and when the target
  slowed enough to pile VUs up — and the second is precisely what stress and spike exist to find.
- **Pool size comes from `vusFor(rate)`, not from the rate.** A VU is held for a whole iteration and the journey's
  think time dominates it, so `preAllocatedVUs: 50` at 50 req/s dropped iterations against a target answering in
  6 ms. Both found by running the shapes, not by reading them.

The value of that guard, measured: starving the pool to 2 VUs against a healthy target reported `p(99) = 11.46 ms`
and a 0 % error rate — a run that looks excellent — while dropping 1071 iterations. Without the threshold it passes
and somebody quotes the number.

`typecheck:perf` exists because k6 transpiles TypeScript with esbuild and verifies none of it. It earned itself on
the first run: `@types/k6` does not declare `console`, so `perf/globals.d.ts` declares it rather than pulling the
entire DOM lib in for one global.

Two defects that only a live run could find, both of which had passed `tsc -b`, eslint and 35 unit tests:
`performance.getEntriesByType('largest-contentful-paint')` returns an **empty array** in Chromium even on a loaded
page, so LCP is read through a `buffered: true` `PerformanceObserver` instead; and **LCP arrives later than the
`load` event** (measured: `load` at 39 ms, first contentful paint at 268 ms on a trivial page), so `collect()` waits
up to 2 s for the first candidate rather than making every caller add a `waitForTimeout`.

Only `@pwtap/create` is versioned by this changeset: `@pwtap/plugin-perf` has never been published, so
`changeset publish` picks up its `0.1.0` from package.json directly. A minor rather than a patch because the
bundled core template changed too — `tsconfig.json` now excludes `perf/`, which belongs to k6's runtime and is
type-checked by its own project instead.
