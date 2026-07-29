# M7 — `@pwtap/plugin-perf` — design and tool evaluation

**Status:** proposal, awaiting a decision on §4. Written for a reader new to performance testing, so §1 defines
the vocabulary the rest depends on. Nothing here is implemented yet.

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

**The five load shapes**, which are the same script with a different ramp:

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
| **Resource budgets** — bundle bytes, request count, third-party weight | CDP network totals per page                       | same                                 |
| Long tasks / main-thread blocking                                      | `PerformanceObserver('longtask')`                 | same                                 |
| Browser-level load (N concurrent real browsers)                        | a load generator that drives Playwright           | **this milestone**, tool-dependent   |
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
test('the product page stays within budget', async ({ page, vitals, budget }) => {
  await page.goto('/products/42');
  const measured = await vitals.collect();
  expect(measured.lcp).toBeLessThan(2500); // the Core Web Vitals "good" threshold
  expect(measured.cls).toBeLessThan(0.1);
  await budget.assert({ totalBytes: 1_500_000, requests: 60 });
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

### Criteria, weighted for this platform

1. **Does it fit the platform's grain?** npm-installable, TypeScript, no second toolchain (ADR-014: use the
   host project's toolchain, never ship a second copy).
2. **Can it reuse what the project already has** — the `pages/` helpers, fixtures, env config?
3. **Load-model correctness**: arrival-rate (open) support, not just VU counts.
4. **CI gating**: thresholds that set an exit code.
5. **Browser load**, for the frontend half.
6. **Headroom**: what happens when the team needs 10× the load or a protocol we did not plan for.

### Candidate A — k6 (Grafana)

The strongest load engine of the three, and the one most people mean by "performance testing".

**For:** a Go binary, so VU density per machine is far beyond anything Node achieves. First-class thresholds
(`http_req_failed: ['rate<0.01']`, `http_req_duration: ['p(99)<1000']`). All six executors including
`ramping-arrival-rate`, which is the correct open model. HTTP, gRPC, WebSocket natively, more via `xk6`
extensions. A browser module over CDP. Mature output ecosystem (Prometheus, Grafana) and a Kubernetes operator
for distributed runs.

**Against, and this is the decisive part:** _k6 does not run on Node._ Its docs are explicit — "k6 uses its own
JavaScript runtime, not Node.js", node_modules are not resolved, and npm dependencies require a bundler.
Concretely, for this platform that means:

- **No reuse.** A k6 script cannot import the project's `pages/` helpers, the `@fixtures` barrel, its env
  loader, or its test data. Flows get written twice and drift apart — the failure mode this whole platform is
  organised against.
- **A second toolchain.** An external binary to install and version, plus a bundler if scripts want any npm
  package. There is precedent (the Maestro CLI), but Maestro is unavoidable for mobile; here there is an
  npm-native alternative doing the same job.
- **A second language dialect** in the repo: k6-flavoured JS that looks like the rest and cannot be type-checked
  by `tsc -b` or linted by the same config.

### Candidate B — Artillery

**For:** plain npm package, TypeScript-native, so it type-checks and lints with everything else. Arrival-rate
phases are its default model, which is the right one. The `ensure` plugin gates CI — checks are filtrex
expressions and a failing `strict` check sets the exit code, so `npm run perf:load` fails a pipeline honestly.
HTTP, WebSocket, Socket.io, gRPC. Distributed load via AWS Lambda/Fargate when one machine stops being enough.

And the one that matters here: **an official Playwright engine.** It launches real Chromium via
`chromium.launch()` and runs a scenario function against a `page`, with full `launchOptions`/`contextOptions`
pass-through and `useSeparateBrowserPerVU`. So browser load testing uses the same library the platform is built
on.

**Against, stated precisely so the recommendation is not oversold:** the Playwright engine does **not** run a
`test()` spec unchanged. It calls a scenario function `(page, vuContext, events)`. Artillery's own guidance is to
lift flow logic into a helper and call it from both places. That is a refactor — a small one here, because the
scaffold already has a `pages/` directory for exactly that, but it is not free and it is not "point Artillery at
your existing tests". Lower VU ceiling per machine than k6 (Node vs Go), and a smaller ecosystem.

### Candidate C — autocannon (the minimal option)

A Node HTTP benchmarking library, embeddable directly in a test.

**For:** the smallest possible footprint — one dependency, no YAML, no external binary, no second runtime. Runs
_inside_ a Playwright test, so a latency budget is asserted with plain `expect` and needs no new command or CI
job. Genuinely the fastest path to "our API's p99 is now gated".

**Against:** single endpoint, single process, no multi-step scenarios, no browser, no ramp shapes. It benchmarks
a URL; it does not model a user journey. Fine as Layer 1's engine, not a substitute for Layer 2.

### Ruled out, with reasons

- **JMeter / Gatling / Locust** — JVM and Python. A whole second ecosystem in a Node repo, for no capability
  Artillery or k6 lacks.
- **Lighthouse** — measures a _lab_ score with its own throttling model; the number moves when Chrome updates,
  which makes it a poor CI gate. Its useful signals (LCP, CLS, TBT) are exactly what Layer 1 reads directly
  from `PerformanceObserver`, without the score's variance.
- **Playwright alone for load** — it has no load model. `test.describe.parallel` with 50 workers is 50 browsers
  on one machine, which measures your laptop.

### Comparison

| Criterion                 | k6                            | Artillery             | autocannon        |
| ------------------------- | ----------------------------- | --------------------- | ----------------- |
| Fits the platform         | external binary + own runtime | npm, TypeScript       | npm, TypeScript   |
| Reuses project code       | **no**                        | yes, via helpers      | n/a (no flows)    |
| Open (arrival-rate) model | yes                           | yes, by default       | rate-limited only |
| CI gating                 | thresholds                    | `ensure` checks       | plain `expect`    |
| Browser load              | k6 browser (CDP)              | **Playwright engine** | no                |
| VU ceiling / machine      | **highest**                   | moderate              | high but one URL  |
| Protocol breadth          | **widest** (+xk6)             | wide                  | HTTP only         |
| New surface for us        | most                          | moderate              | least             |

### Recommendation

**Artillery for Layer 2, autocannon for Layer 1, k6 documented as the escape hatch.**

The reasoning is reuse and surface area, not benchmarks. k6 is the better _engine_; Artillery is the better
_fit_, and fit dominates here because the platform's entire value is one barrel, one set of helpers, one
toolchain. A load tool that cannot import the project's flows guarantees the flows get written twice, and
duplicated flows drift — which produces load tests that pass while testing something the app no longer does.

autocannon earns Layer 1 on its own: an in-suite latency budget needs no scenario model, and adding a second
way to run Artillery just to measure one endpoint would be ceremony.

**Switch to k6 when** — stated now so the decision is reversible on evidence, not vibes: one machine cannot
produce the required arrival rate (roughly, above a few thousand requests/second); a protocol outside HTTP,
WebSocket, Socket.io and gRPC is needed; or the team wants the Grafana/Prometheus operational stack. At that
point Layer 2's scenarios are rewritten in k6 and Layer 1 is untouched — which is why the two layers are
separate.

---

## 5. Proposed design

### Package and dependencies

`packages/plugin-perf`, following the shape M4–M6 settled: `.` / `./manifest` / `./ensure` exports,
`prepack` running the shared clean, and registered in `@pwtap/create`'s registry under a new `performance`
category.

- `dependencies`: `autocannon` (Layer 1's engine).
- `peerDependencies`, optional: `artillery`, `@artillery/engine-playwright` — Layer 2 is opt-in, so a team that
  only wants Web Vitals budgets installs nothing extra. Same policy as `plugin-db`'s SQL drivers.
- `@playwright/test` peer, as every plugin has.

### Layer 1 — three fixtures

Names chosen not to collide with anything existing (`db`/`sql`, `mongoDb`/`mongo`, `mobileTarget`/`mobileApp`,
`maestro`, `app`): the option is **`perfBudget`**, the fixtures are **`vitals`**, **`budget`** and **`bench`**.

- **`vitals`** — Core Web Vitals and navigation timing for the current page, read from `PerformanceObserver`
  and `performance.getEntriesByType('navigation')` inside the page. `collect()` after a navigation returns
  `{ lcp, cls, inp, ttfb, domContentLoaded, load, longTasks }`.
- **`budget`** — resource totals for the page, counted from Playwright's own `response` events (no CDP session
  needed, so it works on every browser): `assert({ totalBytes, requests, byType })`, failing with _which_
  resources blew the budget, sorted largest first. A budget failure that does not name the culprit is a
  puzzle, not a report.
- **`bench`** — a single-endpoint benchmark via autocannon: `await bench.run({ url, duration, connections })`
  → `{ p50, p95, p99, rps, errors, non2xx }`. The `perfBudget` option supplies defaults so a spec asserts
  intent (`expect(result.p99).toBeLessThan(budget.p99)`) rather than repeating numbers.

All three obey the platform's established rule: **an unavailable target skips, never fails**, exactly as an
absent device or database does.

### Layer 2 — scenarios and commands

```
perf/
  load.yml          # arrival-rate phases, the expected peak
  stress.yml        # past peak until something breaks
  spike.yml         # instant surge + a post-spike baseline check
  soak.yml          # nightly, hours
  browser.ts        # Artillery + Playwright engine, calling pages/ helpers
  flows/            # helpers shared by the Playwright specs and the Artillery scenarios
```

Scripts: `perf:smoke`, `perf:load`, `perf:stress`, `perf:spike`, `perf:soak`, `perf:browser`. `perf:smoke`
exists to be run first and always: a load test whose script is broken reports a fast, wrong number.

Thresholds live in the scenario files as Artillery `ensure` checks, so the gate is versioned with the scenario:

```yaml
ensure:
  thresholds:
    - http.response_time.p99: 800
    - http.codes.200: 100 # every request succeeded
  conditions:
    - expression: 'http.request_rate > 190' # the generator actually produced the load it claimed
      strict: true
```

That second condition is the coordinated-omission guard from §1: it fails the run when the _generator_, not
the target, was the bottleneck. Without it a saturated laptop reports excellent latency.

### The shared-flow rule

One rule keeps the two layers honest: **a user journey is written once, in `perf/flows/`, as a function taking
a Playwright `page`.** The Playwright spec calls it; the Artillery scenario calls it. Neither owns it. This is
the concrete answer to Artillery's Playwright engine not running `test()` specs, and it is a better structure
regardless — the scaffold's `pages/` convention already points this way.

---

## 6. What will bite us, named in advance

- **CI variance.** Shared runners vary far more than a real regression. So: Layer 1 budgets are gated in CI
  (they measure bytes and counts, which are stable, plus vitals with deliberately loose bounds); **Layer 2 load
  runs are not gated on a PR.** They run nightly on a consistent machine and compare against a rolling
  baseline. Gating p99 on a shared runner produces a flaky pipeline, and a flaky pipeline gets ignored, which
  is worse than no gate.
- **Load testing from a laptop measures the laptop.** The generator must be the thing with headroom. The
  `http.request_rate` condition above turns this from a silent lie into a failure.
- **Testing an environment nobody agreed to.** A load test against staging with one app instance tells you
  about that instance, not production. The docs must say what the target represents, or the numbers get quoted
  as if they were production capacity.
- **Soak tests and CI minutes.** Hours of load is a nightly job, never a PR one.
- **The vitals-in-CI honesty problem.** LCP on a headless browser on a CI runner is not LCP on a user's phone.
  It catches _regressions_ against itself; it is not a field measurement. Say so, or someone will report the CI
  number to a stakeholder.
- **Lighthouse's pull.** It will be asked for because it gives one number. One number that moves when Chrome
  updates is a bad gate; §4 explains the alternative. Worth deciding once and writing down.

---

## 7. Phases and exit criteria

**Phase 1 — Layer 1, no load generator.** The three fixtures, the manifest, the registry entry, `perf` scope in
commitlint, templates and docs.
→ **Exit:** a scaffolded project asserts Web Vitals and a resource budget on a real page, a `bench` run reports
percentiles against a real endpoint, and each skips cleanly when the target is unreachable. Verified against a
live app, not a mock.

**Phase 2 — Layer 2, load.** Artillery scenarios, the four shapes, `ensure` thresholds, the shared-flow rule,
`perf:smoke` first.
→ **Exit:** each shape runs against a real target and produces a report; the `ensure` gate genuinely fails a
run when a threshold is breached (verified by breaching it on purpose); the request-rate condition fails when
the generator is throttled on purpose.

**Phase 3 — the browser-load and nightly story.** The Artillery Playwright engine over `perf/flows/`, the
nightly workflow with a rolling baseline, soak.
→ **Exit:** N concurrent browsers drive a real flow; the nightly job records a baseline and reports a delta.

**Deliberately not in scope:** Lighthouse (§6), distributed/cloud load (Artillery supports it; nobody needs it
yet), and resilience/chaos testing, which is a different discipline wearing similar clothes.

---

## 8. The decision this document needs

1. **Artillery + autocannon, with k6 as the documented escape hatch** — the recommendation, on fit and reuse.
2. **k6 for Layer 2 instead** — take the stronger engine and accept flows written twice, no `pages/` reuse, and
   an external binary. Defensible if you expect very high load soon or need a protocol outside Artillery's set.
3. **Layer 1 only, for now** — the three fixtures and nothing else. Smallest step, immediate value, and it
   costs nothing later: the layers are independent by design, so Layer 2 can arrive whenever, with either tool.

My recommendation is 1, and if the goal is to get value this week rather than build infrastructure, 3 then 1 is
strictly better than 1 all at once — Layer 1 is where the common regressions actually get caught.
