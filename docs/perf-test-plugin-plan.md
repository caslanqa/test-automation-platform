# M7 — `@pwtap/plugin-perf` — design and tool evaluation

**Status:** §4's tool decision is **made — k6 for Layer 2, autocannon for Layer 1** (2026-08-10). Phase 1 is
being built. Written for a reader new to performance testing, so §1 defines the vocabulary the rest depends on.

---

## 1. The vocabulary, because the words decide the design

Most performance-testing mistakes are vocabulary mistakes. These six distinctions are the ones that change
what you build.

**Average latency is nearly useless; percentiles are the measurement.** If 99 requests take 100 ms and one
takes 10 s, the average is 199 ms and looks fine — while 1 % of your users waited ten seconds. `p95` means "95 %
of requests were at least this fast"; `p99` is where the pain your support inbox hears about lives. Always
state a percentile and never gate on a mean.

**Closed vs open workload models.** A _closed_ model fixes the number of virtual users (VUs): each VU does a
request, waits for the answer, does the next. When the system slows down, the load _drops_ — the users are
politely waiting, so you accidentally stop pushing exactly when you most wanted to. An _open_ model fixes the
arrival rate: 200 requests/second arrive whether or not the previous ones finished, and a slowdown builds a
queue, which is what real traffic does. **Express SLOs in arrival rate, not VU count.** Both tools support
both; the default in most tutorials is the closed one, which is why so many load tests flatter their target.

**The six load shapes**, which are the same script with a different ramp:

| Shape          | Ramp                                   | The question it answers                                   |
| -------------- | -------------------------------------- | --------------------------------------------------------- |
| **Smoke**      | 1–2 VUs, a minute                      | Does the script itself work? Run this before every other. |
| **Load**       | ramp to expected peak, hold, ramp down | Does it meet the SLO at the traffic we actually get?      |
| **Stress**     | past peak until something breaks       | Where is the ceiling, and what breaks first?              |
| **Spike**      | near-instant jump, no plateau          | Does it survive a sudden surge, and does it _recover_?    |
| **Soak**       | modest load for hours                  | Does it leak — memory, connections, file handles?         |
| **Breakpoint** | ramp forever until failure             | Capacity planning: the number to put in a scaling policy. |

Recovery is half of spike testing and is usually forgotten: a system that survives the spike but never returns
to baseline latency has still failed.

**Throughput vs latency vs saturation vs errors** — the four "golden signals". A test that reports only
latency cannot tell a fast system from one that is fast because it is rejecting half the traffic. Always gate
on an error-rate threshold alongside the latency one.

**Warm-up and coordinated omission.** The first requests hit cold caches, empty connection pools and unJITted
code; including them makes every run look worse and noisier. And when a load generator is itself saturated it
stops issuing requests on schedule, quietly under-reporting the latency it was supposed to measure — the load
generator must never be the bottleneck.

**A "performance test" in CI measures the CI runner as much as the system.** Shared runners have noisy
neighbours; the same commit can vary 30 % run to run. This governs the whole design: §7 covers what to gate on
and what merely to record.

---

## 2. What we can actually test — the non-functional map

The question was "which non-functional tests can we do". Here is the honest inventory, marked by what it costs
us. **Already covered** means the platform can do it today.

### Backend / API

| Test                                                | What it needs                             | Status                               |
| --------------------------------------------------- | ----------------------------------------- | ------------------------------------ |
| Latency percentiles + error rate under load         | a load generator + thresholds             | **this milestone**                   |
| Throughput ceiling (breakpoint / capacity)          | ramping arrival rate                      | **this milestone**                   |
| Spike survival **and recovery**                     | spike shape + a post-spike baseline check | **this milestone**                   |
| Soak / leak detection                               | hours of modest load, memory trend        | this milestone, gated to nightly     |
| Single-request latency budget                       | one request, asserted                     | **this milestone**, inside the suite |
| Payload-size budget (an endpoint that quietly grew) | response byte count                       | cheap add-on                         |

### Frontend / browser

| Test                                                                   | What it needs                                     | Status                               |
| ---------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------ |
| **Core Web Vitals** — LCP, CLS, INP/TBT                                | `PerformanceObserver` in the page, per navigation | **this milestone**, inside the suite |
| Navigation timing (TTFB, DOMContentLoaded, load)                       | `performance.getEntriesByType('navigation')`      | same                                 |
| **Resource budgets** — bundle bytes, request count, third-party weight | per-request transfer sizes from Playwright        | same                                 |
| Long tasks / main-thread blocking                                      | `PerformanceObserver('longtask')`                 | same                                 |
| Browser-level load (N concurrent real browsers)                        | a load generator that drives a browser            | **this milestone**, Phase 3          |
| Lighthouse scores                                                      | a separate Chrome + the lighthouse package        | deliberately **out** — see §6        |

### Cross-cutting

| Test                                  | Notes                                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Accessibility                         | **already covered** by the a11y rules; not this plugin's business.                                 |
| Install/build size budgets            | **already covered** by `npm run nfr` for our own packages.                                         |
| Resilience (timeouts, retries, chaos) | Adjacent and valuable, but it is fault injection, not performance. A separate milestone if wanted. |
| Database query performance            | Now possible with `@pwtap/plugin-db` — assert a query's own latency. A natural cheap add-on.       |
| Idle resource use                     | Precedent exists: the inspector's idle-CPU budget was measured this way.                           |

**The trap to name early:** three of these — Web Vitals, resource budgets, single-request latency — need **no
load generator at all**. They are assertions about one user, they belong in the existing suite, and they are
the fastest performance win available. A team that starts by building load infrastructure often never ships
them.

---

## 3. The design's spine: two layers, because load and tests want opposite things

Playwright runs tests in parallel workers, on purpose. A load test needs the machine to itself, on purpose.
Putting load _inside_ the Playwright runner makes both worse: the load test's numbers get noise from other
workers, and the other workers get noise from the load test. So the plugin has two layers with a hard line
between them.

### Layer 1 — inside the suite: single-user performance assertions

Fixtures that measure one page or one request and assert a budget, running alongside the tests you already
have, in the same barrel, gated by the same CI.

```ts
test.use({ perfBudget: { lcp: 2500, cls: 0.1, totalBytes: 1_500_000, requests: 60 } });

test('the product page stays within budget', async ({ page, vitals, budget }) => {
  await page.goto('/products/42');
  await vitals.assert(); // the numbers live in perfBudget, not repeated per spec
  await budget.assert();
});
```

Cheap, parallel-safe, and it catches the most common real regression: someone adds a 400 KB dependency.

### Layer 2 — outside the suite: load, as its own command

`npm run perf:load`, `perf:spike`, `perf:soak`. Runs alone, produces a report, gates on thresholds. Never a
Playwright project, because a Playwright project runs in the shared worker pool — the exact thing to avoid. This
mirrors the choice `plugin-db` made for the opposite reason: db fixtures belong _inside_ other tests, load
belongs outside all of them.

---

## 4. Tool evaluation

> **Revised 2026-08-10.** An earlier draft of this section recommended Artillery for Layer 2, on the grounds
> that a k6 script cannot import the project's own flows. Reading the scaffold instead of assuming settled it
> the other way: **the flows are not importable by either tool**, so the argument that decided it was false.
> §4.0 records the finding, because a reversal is only trustworthy if the reason is on the page.

### 4.0 The finding that changed the decision

`core-template/files/api/core/ApiClient.ts` opens with:

```ts
import type { APIRequestContext, APIResponse } from '@playwright/test';
```

`PetService` builds on `ApiClient`, `ApiClient` builds on Playwright's `APIRequestContext`, and `pages/*` builds
on `page`. The project's HTTP layer is **Playwright-bound by construction**. So:

- **k6 cannot import it** — different runtime, as its docs say plainly.
- **Artillery's HTTP engine cannot import it either** — that engine has its own request layer; there is no
  `APIRequestContext` to hand `new ApiClient(…)`.
- Artillery can only reach it through the **Playwright engine**, via `page.request`, i.e. as a browser VU. That
  is the expensive kind of VU, and not where load volume comes from.

What genuinely gets shared between the functional suite and a load scenario is `env/environments.json` and
`testData/*.json` — **data, not code**. k6 reads those with `open()`; no bundler, no build step, no drift.

There is a second, more important reason not to mourn the code reuse: **a load test should usually not replay a
UI journey.** At 200 requests/second you want the HTTP calls underneath the journey, with explicit think time
and correlation, not a click sequence. The "write the flow once" instinct is right for functional tests and
mostly wrong for load. Sharing the _data_ and the _target contract_ is the reuse that matters.

### Criteria, weighted for this platform

1. **Load-model correctness**: arrival-rate (open) support, not just VU counts, and honest reporting when the
   generator itself cannot keep up.
2. **CI gating**: thresholds that set an exit code.
3. **How much new surface** — binaries, build steps, dialects — does it add.
4. **Reuse of what the project already has.** Kept as a criterion, but weighted by §4.0: this means env config
   and test data, not helper classes.
5. **Browser load**, for the frontend half.
6. **Headroom**: 10× the load, or a protocol we did not plan for.

### Candidate A — k6 (Grafana) — **chosen for Layer 2**

**For:** a Go binary, so VU density per machine is far beyond anything Node achieves. First-class thresholds
(`http_req_failed: ['rate<0.01']`, `http_req_duration: ['p(99)<800']`) that set the exit code with no plugin.
All six executors including `ramping-arrival-rate`, the correct open model — and `dropped_iterations`, a
built-in metric counting the iterations k6 _could not start on schedule_, which turns §1's coordinated-omission
guard into a first-class number instead of a hand-written expression. HTTP, gRPC, WebSocket natively, more via
`xk6`. A `k6/browser` module over CDP whose API is deliberately Playwright-shaped, and which can run **protocol
VUs and browser VUs in the same test under shared thresholds** — 950 API VUs plus 50 real-browser VUs, one
gate. Nothing in the Node ecosystem does that. Mature output ecosystem (Prometheus, Grafana) and a Kubernetes
operator for distributed runs.

**Against, stated precisely.** k6 does not run on Node, and its own docs are the source (verified, not
recalled):

> "k6 transpiles TypeScript (TS) code using esbuild for files with the `.ts` extension. However, TypeScript
> support is **partial as it only strips type information and does not provide type safety**."

> "It does not support the Node.js module resolution algorithm."

So, concretely, the real costs:

- **`perf/` sits outside `tsc -b`.** You may write TypeScript, but k6 will not check it. Mitigation, to verify
  in Phase 2: a separate `perf/tsconfig.json` using `@types/k6` (2.0.1 on npm) plus a `typecheck:perf` script,
  so the scripts are checked by _our_ toolchain even though the runtime ignores types.
- **A third external binary.** The repo already ships two (the Maestro CLI, the Appium server) and has the
  `ensure` mechanism for exactly this: an advisory check that names the missing binary instead of failing
  obscurely at first run.
- **No npm packages inside a k6 script** without adding a bundler. Accepted deliberately: after §4.0 there is
  nothing left worth importing, and the moment a bundler appears the "no second toolchain" rule is broken for
  real.

### Candidate B — Artillery

**For:** plain npm package, TypeScript-native, so scenarios type-check and lint with everything else — the one
advantage that survives §4.0 intact. Arrival-rate phases are its default model. The `ensure` plugin gates CI via
filtrex expressions and a failing `strict` check sets the exit code. HTTP, WebSocket, Socket.io, gRPC.
Distributed load via AWS Lambda/Fargate. An official Playwright engine that launches real Chromium and runs a
scenario function against a `page`.

**Against:** its Playwright engine does not run a `test()` spec unchanged — it calls
`(page, vuContext, events)`, so flow logic has to be lifted into a helper either way. Lower VU ceiling per
machine (Node vs Go). No equivalent of `dropped_iterations`: the generator-saturation guard must be written by
hand as an expression on `http.request_rate`, which is weaker because it compares against a number a human
typed. And protocol load and browser load cannot be mixed in one run under one gate.

### Candidate C — autocannon — **chosen for Layer 1**

A Node HTTP benchmarking library, embeddable directly in a test.

**For:** the smallest possible footprint — one dependency, no YAML, no external binary, no second runtime. Runs
_inside_ a Playwright test, so a latency budget is asserted with plain `expect` and needs no new command or CI
job. Genuinely the fastest path to "our API's p99 is now gated".

**Against:** single endpoint, single process, no multi-step scenarios, no browser, no ramp shapes. It benchmarks
a URL; it does not model a user journey. Fine as Layer 1's engine, not a substitute for Layer 2.

**One API detail that shapes the fixture** (verified against autocannon's docs, not assumed): its HDR histogram
exposes `p50, p75, p90, p97_5, p99, p99_9, …` — **there is no `p95`.** So `bench` reports `p97_5` and says so.
Interpolating a `p95` from neighbouring buckets to match a nicer-sounding name would be inventing a number.

### Ruled out, with reasons

- **JMeter / Gatling / Locust** — JVM and Python. A whole second ecosystem in a Node repo, for no capability k6
  lacks.
- **Lighthouse** — measures a _lab_ score with its own throttling model; the number moves when Chrome updates,
  which makes it a poor CI gate. Its useful signals (LCP, CLS, TBT) are exactly what Layer 1 reads directly
  from `PerformanceObserver`, without the score's variance.
- **Playwright alone for load** — it has no load model. `test.describe.parallel` with 50 workers is 50 browsers
  on one machine, which measures your laptop.

### Comparison

| Criterion                  | k6                                      | Artillery                      | autocannon        |
| -------------------------- | --------------------------------------- | ------------------------------ | ----------------- |
| Open (arrival-rate) model  | yes, 6 executors                        | yes, by default                | rate-limited only |
| Generator-saturation guard | **`dropped_iterations`, built in**      | hand-written expression        | n/a               |
| CI gating                  | native thresholds                       | `ensure` checks                | plain `expect`    |
| Reuses project **code**    | no                                      | no (see §4.0)                  | n/a               |
| Reuses project **data**    | yes, `open()`                           | yes                            | n/a               |
| Covered by `tsc -b`        | no — separate `typecheck:perf`          | **yes**                        | yes               |
| Browser load               | `k6/browser`, **mixable with protocol** | Playwright engine, not mixable | no                |
| VU ceiling / machine       | **highest**                             | moderate                       | high but one URL  |
| Protocol breadth           | **widest** (+xk6)                       | wide                           | HTTP only         |
| New surface for us         | a binary + a dir `tsc -b` misses        | an npm dep                     | least             |

### Decision

**k6 for Layer 2, autocannon for Layer 1.**

Once §4.0 removes reuse from Artillery's side of the ledger, the comparison is between a stronger engine with a
type-checking gap we can close ourselves, and a weaker engine whose only remaining advantage _is_ that gap. k6
wins on what a load tool is actually for: the open model, thresholds as a first-class exit code,
`dropped_iterations` telling you when your own generator lied, VU density, and a browser module that mixes with
protocol load under one gate.

The binary is not the objection it looks like. This repo already installs Maestro and Appium, has an `ensure`
hook whose whole job is to say "the k6 binary is not on PATH — `brew install k6`", and treats external tooling
as normal.

autocannon earns Layer 1 on its own: an in-suite latency budget needs no scenario model, and standing k6 up to
measure one endpoint inside a functional test would be ceremony — worse, it would put an arrival-rate load
generator inside the Playwright worker pool, which §3 exists to prevent.

**Reconsider Artillery when** — stated now so the decision is reversible on evidence: the team wants load
scenarios inside `tsc -b` badly enough to trade the engine for it, or a scenario genuinely needs an npm package
that cannot be reimplemented in a k6 script. Layer 1 is untouched either way, which is why the two layers are
separate.

---

## 5. Proposed design

### Package and dependencies

`packages/plugin-perf`, following the shape M4–M6 settled: `.` / `./manifest` / `./ensure` exports,
`prepack` running the shared clean, and registered in `@pwtap/create`'s registry under a new `performance`
category.

- `dependencies`: `autocannon` (Layer 1's engine).
- `devDependencies`: `@types/autocannon` — types only, never referenced by the emitted `.d.ts`, which describes
  our own `BenchResult` instead.
- **k6 is not an npm dependency at all.** It is an external binary, like the Maestro CLI: `ensure` reports its
  absence, `docs/PERF_TESTING.md` says how to install it, and nothing in `dist/` imports it.
- `@playwright/test` peer, as every plugin has.

### Layer 1 — three fixtures

Names chosen not to collide with anything existing (`db`/`sql`, `mongoDb`/`mongo`, `mobileTarget`/`mobileApp`,
`maestro`, `app`): the option is **`perfBudget`**, the fixtures are **`vitals`**, **`budget`** and **`bench`**.

Each fixture measures without asserting — `collect()`, or `run()` for `bench` — and `assert()` compares against
`perfBudget`, failing with the culprit named. Budgets live in the option so a spec states intent once.

- **`vitals`** — Core Web Vitals and navigation timing for the current page, read from the page's own
  performance timeline. `collect()` returns
  `{ ttfb, fcp, domContentLoaded, load, lcp, cls, inp, tbt, longTasks }`.
  Support is read at run time from `PerformanceObserver.supportedEntryTypes` rather than assumed, and `assert()`
  _skips_ when the budget names a metric this browser cannot measure — the platform's "unavailable means skip"
  rule, applied to a missing API rather than a missing device. **Measured, and it corrected an assumption in an
  earlier draft of this section:** on Playwright 1.61's own builds, `lcp` and `inp` come back from Chromium,
  WebKit AND Firefox; only `cls`, `tbt` and `longTasks` need `layout-shift`/`longtask` entries and are
  Chromium-only.
- **`budget`** — resource totals for the page, accumulated from Playwright's own `requestfinished` event and
  `request.sizes()`, so it is real transfer size and needs no CDP session.
  `assert({ totalBytes, requests, byType })` fails with _which_ resources blew the budget, largest first. A
  budget failure that does not name the culprit is a puzzle, not a report.
- **`bench`** — a single-endpoint benchmark via autocannon: `await bench.run({ path: '/api/health' })` →
  `{ p50, p90, p97_5, p99, rps, errors, non2xx, errorRate }`. `path` resolves against Playwright's own
  `baseURL` option, so there is no new env key to configure; an absolute `url` overrides it. An unreachable
  target skips; a 404 does not — something is listening, and a wrong path is the benchmark's business to report
  as `non2xx`.

**`bench` is a budget check, not a load test.** It runs inside a Playwright worker, so its absolute numbers are
worth what the machine and the other workers make them worth. Defaults are small on purpose and the docs say to
run it with `--workers=1` if the number is going to be quoted. Load lives in Layer 2, and this is the line §3
draws.

### Layer 2 — k6 scripts and commands

```
perf/
  tsconfig.json     # @types/k6, so `npm run typecheck:perf` checks what k6 will not
  lib/
    env.ts          # open()s env/environments.json — the shared DATA, per §4.0
    data.ts         # open()s testData/*.json
  smoke.ts          # 1–2 VUs, run first, always
  load.ts           # arrival-rate at the expected peak
  stress.ts         # past peak until something breaks
  spike.ts          # instant surge + a post-spike baseline check
  soak.ts           # nightly, hours
  browser.ts        # k6/browser, Phase 3
```

Scripts: `perf:smoke`, `perf:load`, `perf:stress`, `perf:spike`, `perf:soak`, `perf:browser`, `typecheck:perf`.
`perf:smoke` exists to be run first and always: a load test whose script is broken reports a fast, wrong number.

Thresholds live in the script's own `options`, so the gate is versioned with the scenario and k6 sets the exit
code itself — no plugin, no wrapper interpreting output:

```ts
export const options = {
  scenarios: {
    load: {
      executor: 'ramping-arrival-rate', // open model, per §1
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 500,
      stages: [
        { target: 200, duration: '2m' },
        { target: 200, duration: '5m' },
        { target: 0, duration: '1m' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'], // §1: never gate latency without an error gate
    http_req_duration: ['p(99)<800'],
    dropped_iterations: ['count<1'], // the generator produced the load it claimed
  },
};
```

That third threshold is §1's coordinated-omission guard: `dropped_iterations` counts iterations k6 could not
start on schedule, so the run fails when the _generator_, not the target, was the bottleneck. Without it a
saturated laptop reports excellent latency.

### The shared-data rule

§4.0 killed the shared-flow rule, and the replacement is narrower and honest: **the two layers share data, not
code.** `env/environments.json` and `testData/*.json` are read by the Playwright suite through `config/loadEnv`
and by k6 through `open()`. Nothing else crosses the line. A k6 script talks to the HTTP API directly, which is
what a load script should do anyway.

The runner is thin on purpose. If a JS-side helper ever wraps `k6 run`, it may pass `--out` and env values, and
it must **not** own thresholds — those belong in the script, next to the scenario they gate.

---

## 6. What will bite us, named in advance

- **CI variance.** Shared runners vary far more than a real regression. So: Layer 1 budgets are gated in CI
  (they measure bytes and counts, which are stable, plus vitals with deliberately loose bounds); **Layer 2 load
  runs are not gated on a PR.** They run nightly on a consistent machine and compare against a rolling
  baseline. Gating p99 on a shared runner produces a flaky pipeline, and a flaky pipeline gets ignored, which
  is worse than no gate.
- **`perf/` is not type-checked by the runtime.** k6 strips types; it does not check them. If `typecheck:perf`
  is not wired into CI, the directory silently becomes untyped JavaScript wearing a `.ts` extension. This is
  the cost we accepted in §4 and the one most likely to be quietly dropped.
- **Load testing from a laptop measures the laptop.** The generator must be the thing with headroom. The
  `dropped_iterations` threshold turns this from a silent lie into a failure.
- **Testing an environment nobody agreed to.** A load test against staging with one app instance tells you
  about that instance, not production. The docs must say what the target represents, or the numbers get quoted
  as if they were production capacity.
- **Soak tests and CI minutes.** Hours of load is a nightly job, never a PR one.
- **The vitals-in-CI honesty problem.** LCP on a headless browser on a CI runner is not LCP on a user's phone.
  It catches _regressions_ against itself; it is not a field measurement. Say so, or someone will report the CI
  number to a stakeholder.
- **`bench` will be mistaken for a load test**, because it produces percentiles. It runs in the worker pool.
  Layer 1's docs have to keep saying so.
- **Lighthouse's pull.** It will be asked for because it gives one number. One number that moves when Chrome
  updates is a bad gate; §4 explains the alternative. Worth deciding once and writing down.

---

## 7. Phases and exit criteria

**Phase 1 — Layer 1, no load generator. DONE (2026-08-10).** The three fixtures, the manifest, the registry entry,
templates and docs. (`perf` is already an accepted commitlint scope.)
→ **Exit met:** a scaffolded project asserts Web Vitals and a resource budget on a real page, `bench` reports
percentiles against a real endpoint, and each skips cleanly when the target is unreachable or the browser cannot
measure the metric — verified in a fresh scaffold against a live site and against purpose-built loopback pages,
plus 35 unit tests over the arithmetic.

Two defects only the live run could find, both of which had passed every structural check:

1. **`performance.getEntriesByType('largest-contentful-paint')` returns an empty array in Chromium** even on a
   fully loaded page. LCP is only retrievable through a `PerformanceObserver` with `buffered: true`. The harvest
   now reads the dynamic entry types that way, and cross-checks `layout-shift`/`longtask` against the direct read,
   taking whichever list is longer.
2. **LCP arrives later than the `load` event** — measured, on a trivial local page: `load` at 39 ms, first
   contentful paint at 268 ms. So collecting right after `waitUntil: 'load'` finds nothing, and the shipped example
   skipped. `collect()` now waits up to 2 s for the first candidate rather than making every caller sleep.

And one documentation claim that measurement refuted: `lcp` and `inp` are **not** Chromium-only. Both came back
from Playwright's WebKit and Firefox builds (INP 320 ms and 304 ms against a deliberately slow click handler).

**Phase 2 — Layer 2, load with k6. DONE (2026-08-11).** Five shapes in `perf/` (smoke, load, stress, spike, soak)
sharing one `journey()`, native thresholds in each script's own `options`, `perf/lib/env.ts` reading
`env/environments.json` through `open()`, `perf/tsconfig.json` + `typecheck:perf`, the `ensure` check for the
binary, `perf:smoke` first.
→ **Exit met**, every criterion verified against a real loopback target on k6 v2.2.0:

- **Each shape ran and produced a report.** smoke 20/20 checks; load 4139 iterations at 39 req/s, all thresholds
  green, exit 0; stress climbed 50→200 req/s over 2m15s; spike surged at 250 req/s then recovered
  (`p(95){scenario:recovery}` = 6.82 ms); soak green on a duration-shortened copy (the shipped default is 30 min).
- **A breached threshold fails with a non-zero exit code**, verified by breaching it on purpose: the target was
  slowed to 900 ms and `p(99)<800` went red — **exit 99**.
- **`dropped_iterations` fails a starved generator**, verified by starving it on purpose: 2 VUs against a target
  answering in 11 ms produced `p(99)=11.46ms`, `http_req_failed 0.00%` and **1071 dropped iterations** — a run that
  looks excellent while a third of the intended traffic was never sent. Exit 99.
- **`typecheck:perf` catches a deliberate type error**: `http_req_duration: 800` instead of `['p(99)<800']` →
  `error TS2322: Type 'number' is not assignable to type 'Threshold[]'`.
- Also verified: `abortOnFail` on stress's error gate stopped a run **2 seconds into 2m15s** when half the responses
  were 500s; an unset `PERF_TARGET_URL` aborts at init before any request; `ensure` warns by name when the k6 binary
  is off PATH; `PERF_TARGET_URL` in an `environments.<env>` block wins over an empty `common`.

Two design corrections came out of running it, neither visible to any structural check:

1. **`preAllocatedVUs` sized from the rate is wrong**, because a VU is held for a whole iteration and `journey()`'s
   think time dominates that. `preAllocatedVUs: 50` at 50 req/s dropped 2 iterations against a target answering in
   6 ms — so the shipped `load.ts` would have failed on every user's first run, and the obvious response is to
   delete the very threshold that makes the run honest. `perf/lib/flow.ts` now exports `vusFor(rate)` and every
   scenario sizes its pool with it.
2. **`dropped_iterations` must not be gated in `stress.ts` or `spike.ts`.** The metric rises both when the pool is
   too small and when the target got slow enough to pile VUs up — and the second is exactly what those two shapes
   exist to find, so the gate would fire at the moment the run answers the question. It stays in `load.ts` and
   `soak.ts`, where the target is expected to keep up. `stress.ts` additionally pre-allocates for its top stage
   (which took allocation-lag drops from 113 to 0), so a count there attributes to the target.

Also, `@types/k6` does not declare `console`; `perf/globals.d.ts` declares it rather than pulling the whole DOM lib
in for one global — found by `typecheck:perf` on its first run, which is the argument for having it.

**Phase 3 — browser load and the nightly story.** `k6/browser`, protocol and browser VUs mixed in one scenario
under shared thresholds, the nightly workflow with a rolling baseline, soak.
→ **Exit:** N concurrent browsers drive a real flow; a single run reports both API and browser metrics against
one gate; the nightly job records a baseline and reports a delta.

**Deliberately not in scope:** Lighthouse (§6), distributed/cloud load (k6 supports it; nobody needs it yet),
and resilience/chaos testing, which is a different discipline wearing similar clothes.

---

## 8. Decision log

- **2026-08-10 — Layer 2 = k6, Layer 1 = autocannon.** Decided after §4.0 showed the reuse argument that had
  favoured Artillery does not hold: the scaffold's HTTP layer is Playwright-bound, so no external load tool can
  import it. Costs accepted knowingly: a third external binary, and a `perf/` directory outside `tsc -b` whose
  types are checked by a separate `typecheck:perf` project instead.
- **Superseded:** the earlier recommendation of "Artillery for Layer 2, k6 as the escape hatch". Kept visible
  in §4's revision note rather than deleted, so the reversal can be judged on its reason.
- **Open, deferred to Phase 3:** whether browser load runs on `k6/browser` or on Artillery's Playwright engine.
  Layer 2's protocol choice does not decide it — treating it as though it did was the earlier draft's mistake.
