# Performance testing

Two layers with a hard line between them.

**Layer 1** (§2–§5) asserts single-user performance inside the suite you already have: three fixtures — `vitals`,
`budget`, `bench` — one option, `perfBudget`, and no environment variables at all.

**Layer 2** (§6) is load testing with k6: ramp shapes, arrival-rate models and thresholds, run as its own command
outside the Playwright runner, because a load generator inside a parallel worker pool measures the worker pool.

Read this in order. Each step assumes the one before it.

---

## 1. Know what each layer measures

**Layer 1** measures a single page load or a single endpoint and asserts a budget. It catches the regression that
actually happens — someone adds a 400 KB dependency, an endpoint gets a new N+1 query — and it costs nothing,
because it rides along with tests you were already running. Most teams get more from this than from any load test,
and it is the part that fits in a pull request.

**Layer 2** answers a different question: what happens at traffic. It needs a target you have decided to load, a
machine with headroom, and a nightly slot rather than a per-commit one.

The words that matter before you set a single number:

- **Percentiles, never averages.** If 99 requests take 100 ms and one takes 10 s, the average is 199 ms and looks
  healthy while 1 % of users waited ten seconds. Gate on `p99`.
- **Always gate errors next to latency.** A service that is fast because it rejects half the traffic reports
  excellent latency. `errorRate` is not optional.
- **A budget in CI measures the CI runner too.** Bytes and request counts barely move between runs, which is why
  they are the budgets worth gating. Vitals move a lot; keep those bounds loose and treat them as
  regression detection against your own baseline, not as a field measurement of what users experience.

---

## 2. Configure the budgets — in the spec, not in the environment

Every other plugin here reads `env/environments.json`. This one does not, deliberately: an LCP ceiling is part of
the test, not part of the deployment, so it belongs in a versioned file next to the assertion.

```ts
test.use({
  perfBudget: {
    lcp: 2500,
    cls: 0.1,
    ttfb: 800,
    totalBytes: 1_500_000,
    requests: 60,
    byType: { script: 400_000, image: 600_000 },
    bench: { p99: 800, errorRate: 0, connections: 10, duration: 5 },
  },
});
```

Set it at the top level of a file. `assert()` with no argument checks exactly these; an explicit argument
overrides them for one call.

**Measure before you choose numbers.** Run `collect()`, read the output, then set the ceiling just above what you
are willing to accept. A budget nobody can breach is documentation, not a test.

`bench.duration` is in seconds. Prefer `bench.amount` (a fixed number of requests) in CI: it makes the run's cost
predictable and the comparison between runs fairer.

---

## 3. Write the checks

### `vitals` — Core Web Vitals and navigation timing

```ts
test('the product page stays within budget', async ({ page, vitals }) => {
  await page.goto('/products/42', { waitUntil: 'load' });
  const measured = await vitals.assert();
  console.info(measured.lcp, measured.cls);
});
```

`collect()` returns, all in ms except `cls` (unitless) and `longTasks` (a count):

| Metric             | What it is                                                      | Chromium | WebKit | Firefox |
| ------------------ | --------------------------------------------------------------- | -------- | ------ | ------- |
| `ttfb`             | `responseStart` — time to first byte                            | yes      | yes    | yes     |
| `domContentLoaded` | `domContentLoadedEventEnd`                                      | yes      | yes    | yes     |
| `load`             | `loadEventEnd`; absent until the load event fires               | yes      | yes    | yes     |
| `fcp`              | First Contentful Paint                                          | yes      | yes    | yes     |
| `lcp`              | Largest Contentful Paint                                        | yes      | yes    | yes     |
| `inp`              | Interaction to Next Paint — needs a real interaction            | yes      | yes    | yes     |
| `cls`              | Cumulative Layout Shift, worst session window                   | yes      | **no** | **no**  |
| `tbt`              | Total Blocking Time, the lab stand-in for INP                   | yes      | **no** | **no**  |
| `longTasks`        | Tasks that blocked the main thread over 50 ms, counted from FCP | yes      | **no** | **no**  |

That table is **measured**, on Playwright 1.61's own browser builds, not copied from a compatibility chart: `lcp`
and `inp` came back from all three (`inp` was 320 ms on WebKit and 304 ms on Firefox against a deliberately slow
click handler), and only `layout-shift` and `longtask` entries were missing outside Chromium. "LCP and INP are
Chromium-only" is a common claim and was wrong here. Support is read at run time from
`PerformanceObserver.supportedEntryTypes`, so this adapts as browsers change; the skip message always names the
entry type that was actually missing.

Three details worth knowing, because they are where hand-rolled vitals go wrong:

- **`cls` is the worst 5-second session window, not the sum of every shift** (sessions split after a 1 s gap, or
  once one has run 5 s), and shifts the user caused are excluded. A sum over-reports any long-lived page.
- **`inp` is the worst interaction**, where all entries sharing an `interactionId` count as one interaction. Under
  50 interactions — every automated test — that is exactly the metric's definition, so no percentile is involved.
  Interactions faster than about 104 ms are below the browser's buffering threshold and invisible; an INP budget
  worth asserting is far above that.
- **`tbt` has no upper bound here.** Lighthouse measures TBT between FCP and Time to Interactive; this counts every
  long task after FCP, so a slow interaction you perform in the test counts towards it. That is usually what you
  want in a test, but it is not the same number Lighthouse prints.

Collect **after** the page reaches the state you want measured: LCP keeps being revised upward until the user
interacts.

`collect()` waits, up to 2 seconds, for the first LCP candidate. It has to: **LCP arrives later than the load
event** — measured at 39 ms for `load` against 268 ms for the first contentful paint on a trivial local page — so
reading straight after `waitUntil: 'load'` would find nothing. You do not need a `waitForTimeout` before
collecting; if a page genuinely never paints anything contentful, the wait elapses once and an `lcp` budget skips
with the reason.

### `budget` — bytes and requests

```ts
test('the page does not grow', async ({ page, budget }) => {
  await page.goto('/');
  const measured = await budget.assert();
  console.info(`${measured.requests} requests, ${measured.totalBytes} bytes`);
});
```

Counted from Playwright's own request events and `request.sizes()`, so these are real transfer sizes (response body
plus response headers) on every browser, with no CDP session involved. `collect()` returns the totals, the per-type
breakdown, and `resources` — the individual requests, if you want to assert something the budget does not express.

**`collect()` waits for the network to go quiet first**, up to 2 seconds, and that wait is the difference between a
number and a guess. A page keeps loading after its `load` event: fonts, lazy images, a fetch a component fires on
mount. Measured on the scaffold's own demo site, the same page read three ways — 4 requests and 181 kB at `load`,
9 requests and 249 kB once quiet; and a route reached by clicking reported **0 requests** when read immediately
while 6 images were still in flight. A budget built on the early number passes while the page has tripled.

Pass `collect({ settleMs })` to change the wait, or `collect({ settleMs: 0 })` to read immediately. Raise it for a
page that legitimately keeps loading longer; a page with a websocket or polling never goes quiet at all, so the wait
expires and you measure what arrived rather than hanging. `assert()` takes the same option as its second argument.

A breach names the largest offenders, largest first:

```
[perf] resource budget exceeded:
  - total transfer 1.72 MB exceeds the 1.50 MB budget — largest: script https://app/vendor.js (900 kB), …
```

`reset()` forgets everything recorded so far, which is what lets a journey measure each step on its own instead of
watching every page look heavier than the last:

```ts
await page.goto('/');
const landing = await budget.collect();

budget.reset();
await page.getByRole('button', { name: 'Sign in' }).click();
const next = await budget.collect();

// For a step after the first, the useful bound is usually relative — and measured, not guessed.
expect(next.totalBytes).toBeLessThan(landing.totalBytes * 3);
```

### `bench` — one endpoint's latency percentiles

```ts
test('the health endpoint is fast', async ({ bench }) => {
  const result = await bench.assert({ path: '/api/health' });
  console.info(result.p50, result.p97_5, result.p99, result.rps);
});
```

`path` resolves against Playwright's `baseURL`, so the host is configured once in `env/environments.json`; an
absolute `url` overrides it. `run()` returns the result without asserting; `assert()` checks `perfBudget.bench`.

Result fields: `p50`, `p90`, `p97_5`, `p99`, `mean`, `max`, `rps`, `totalRequests`, `responses`, `errors`,
`timeouts`, `non2xx`, `errorRate`.

**There is no `p95`.** autocannon's HDR histogram has p50, p75, p90, p97_5 and p99 buckets; interpolating a p95
from the neighbours to match a nicer-sounding name would be inventing a number. Use `p97_5` and say `p97.5` when
you report it.

---

## 4. Run them

```bash
npm run test:perf          # tests/perf with --workers=1
npx playwright test        # they also run as part of the whole suite
```

`--workers=1` matters for `bench` only, and it matters a lot: `bench` runs inside a Playwright worker, so a
percentile measured while five browsers are running is a number about your machine, not your service. `vitals`
and `budget` are unaffected — bytes and paint timings do not care how many workers are alive.

Never point `bench` at a public demo site or at production without deciding to. The shipped example benchmarks a
loopback server it starts itself, for exactly that reason.

---

## 5. Read the result

Every measurement is written into the run, so nothing depends on scrolling back through stdout. Two forms, because
they answer different questions:

**A one-line annotation per fixture**, shown next to the test in the HTML report and carried in the JSON reporter:

```
perf:vitals     lcp 512ms · cls 0.002 · tbt 0.0ms · ttfb 128ms · fcp 388ms · load 329ms
perf:resources  9 requests · 249 kB (script 169 kB, font 67 kB, stylesheet 11 kB)
perf:bench      p50 1.2ms · p97.5 3ms · p99 12ms · 850 req/s · 0.00% errors
```

Only the metrics that were actually measured appear, so a WebKit run simply has no `cls` in its line rather than a
misleading zero. Measuring twice in one test updates the row instead of appending, so the numbers describe the test
rather than trailing its history.

**The full measurement as an attachment** — `perf-vitals.json`, `perf-resources.json`, `perf-bench.json`. These are
written at fixture teardown, which means **also when the test failed**, and that is the run whose numbers someone
actually needs. `perf-resources.json` lists every request with its type and transfer size, which is how "what grew"
gets answered without re-running with the network tab open. `perf-bench.json` is an array, so a test that benchmarks
two endpoints keeps both.

Open them with `npx playwright show-report`, or read `test-results/results.json` in CI to track a trend.

A breached budget **fails** and names the culprit. A budget that could not be measured **skips** with the reason —
the same rule an absent device or an unreachable database follows here. Every skip message, and what to do:

| Skip reason                                                             | What happened                                                       | Fix                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `cls needs "layout-shift" entries, which this browser does not support` | `cls`, `tbt` or `longTasks` was budgeted on WebKit or Firefox       | Run that budget on the chromium project, or budget `lcp`/`ttfb`      |
| `inp was not reported by this run … INP needs a real interaction`       | Nothing was clicked or typed, so there is no interaction to measure | Interact before collecting, or drop `inp` from the budget            |
| `lcp was not reported by this run … navigate before collecting`         | The page painted nothing contentful within the 2 s LCP wait         | Check the page actually renders; budget `ttfb`/`fcp` for an API page |
| `load was not reported by this run … the load event had not fired`      | Collected too early                                                 | `page.goto(url, { waitUntil: 'load' })`                              |
| `ttfb was not reported by this run … navigate before collecting`        | `collect()` ran on `about:blank`                                    | Navigate first                                                       |
| `bench.run needs a url or a path`                                       | Neither was passed                                                  | Pass one                                                             |
| `bench.run({ path: … }) needs a baseURL`                                | `use.baseURL` is unset and only a path was given                    | Set `BASE_URL` in `env/environments.json`, or pass an absolute url   |
| `could not reach <url>: <error>`                                        | Nothing is listening, or DNS/TLS failed                             | Start the service, or check the URL                                  |
| `autocannon is not resolvable from this project`                        | An install that skipped dependency resolution                       | `npm install`                                                        |

Two things fail rather than skip, on purpose:

- **`assert()` with an empty budget throws.** A budget that checks nothing would pass forever and mean nothing.
- **A real breach beats an unmeasurable metric.** If a budget names both `ttfb` (breached) and `lcp` (unsupported
  here), the run fails on `ttfb` — skipping would hide it.

A 404 is **not** a skip. Any HTTP response means something is listening, and a wrong path is the benchmark's
business to report as `non2xx`; only a transport failure skips.

---

## 6. Layer 2 — load, with k6

Everything above measures one user. This measures many, and it runs **outside** the Playwright runner: a load
generator inside a parallel worker pool measures the worker pool. So Layer 2 is a directory of k6 scripts plus
`perf:*` commands, with no Playwright involvement at all.

k6 is not an npm package — it runs its own JavaScript runtime, not Node, which means it cannot import
`config/loadEnv.ts`, `pages/` or `api/`. Those are built on Playwright's `APIRequestContext` and `page`, so no
external load tool could import them either; what the two layers share is the **data** in
`env/environments.json`, read here through k6's `open()`.

### 6.1 Install the binary

There is **no npm route**, and it is worth knowing why rather than searching for one: k6 runs its own JavaScript
runtime instead of Node, so it is not installable the way `playwright` is, and the `k6` package on npm is a stub
for editor autocomplete rather than the binary.

| Your machine         | Command                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| macOS                | `brew install k6`                                                              |
| Debian / Ubuntu      | add the k6 apt repository (4 commands, in the docs), `apt-get install k6`      |
| Fedora / RHEL        | `sudo dnf install https://dl.k6.io/rpm/repo.rpm && sudo dnf install k6`        |
| Windows              | `winget install k6 --source winget`, or `choco install k6`                     |
| Anything, no install | `docker run --rm -i -v "$PWD:/src" -w /src grafana/k6 run perf/smoke.ts`       |
| No package manager   | a standalone binary from [k6 releases](https://github.com/grafana/k6/releases) |

Full instructions: <https://grafana.com/docs/k6/latest/set-up/install-k6/>.

**`create-pwtap add perf` does not install it**, deliberately — a scaffold step that reaches for a system package
manager, or `sudo`, is not a side effect anyone asked for. What it does is work out the command that is right for
_your_ machine and print that: it probes for `brew` / `apt-get` / `dnf` / `yum` / `winget` / `choco` and names the
one it found, or, when it finds none, points at the standalone binary and the Docker route. A hardcoded
`brew install k6` would be wrong on every Linux CI runner and on any Mac without Homebrew, and an instruction that
cannot work is worse than none — the reader assumes their machine is broken.

The check runs the binary rather than only looking for it on PATH, so a shim of the wrong architecture is reported
too. It also says that the Layer 1 fixtures do not need k6, because most of this plugin works without it.

If you take the Docker route, remember the container's `localhost` is not yours: add `--network host`, or target
`host.docker.internal`, to reach a service running on this machine.

### 6.2 Name the target — explicitly

Set `PERF_TARGET_URL` inside the `environments.<env>` block you mean, **not** under `common`: a load target belongs
to one deployment.

```json
{
  "environments": {
    "staging": { "PERF_TARGET_URL": "https://staging.example.com/" }
  }
}
```

There is deliberately **no fallback** to `BASE_URL` or `API_BASE_URL`. Those point at whatever the functional suite
uses — in a fresh scaffold, public demo services — and inheriting them is how a laptop ends up sending 200 requests
a second at a site nobody agreed to. Unset, every scenario aborts at init with that instruction, before a single
request goes out. For one run: `k6 run -e PERF_TARGET_URL=http://localhost:3000/ perf/load.ts`.

Say in your own docs **what the target represents**. A load test against staging with one app instance tells you
about that instance; quoted later without that sentence, it becomes a claim about production capacity.

### 6.3 Write the journey once

`perf/lib/flow.ts` exports one `journey()` function, and all five shapes import it — the shapes differ in their
ramp, not in what a virtual user does. Replace its contents with the requests your app actually serves.

A load journey is usually **not** your Playwright test rewritten. At a few hundred requests a second you want the
HTTP calls underneath a user journey, with correlation and think time, rather than a click sequence.

### 6.4 The five shapes

Run smoke first. Always. A load test whose journey is broken reports a fast, wrong number, confidently.

| Command               | Shape                            | What it answers                     | Gated on                                            |
| --------------------- | -------------------------------- | ----------------------------------- | --------------------------------------------------- |
| `npm run perf:smoke`  | 1 VU, 20 s                       | Does the script itself work?        | errors, checks                                      |
| `npm run perf:load`   | ramp to peak, hold, down         | Do we meet the SLO at real traffic? | errors, `p(99)`, `dropped_iterations`               |
| `npm run perf:stress` | past peak in stages              | Where is the ceiling?               | error rate only, with `abortOnFail`                 |
| `npm run perf:spike`  | 5× surge, then a quiet window    | Does it survive **and recover**?    | recovery `p(95)` and errors, scoped by scenario tag |
| `npm run perf:soak`   | modest load for 30 min (nightly) | Does it leak?                       | errors, a looser `p(99)`, `dropped_iterations`      |

Thresholds live in each script's own `options`, so the gate is versioned with the scenario and k6 sets the exit
code itself — a breached threshold exits 99. Nothing wraps k6 to interpret its output.

Two shapes deserve their notes:

- **Spike gates only the recovery window**, using k6's per-scenario tags
  (`'http_req_duration{scenario:recovery}'`). Recovery is half of spike testing and the half everyone forgets: a
  system that absorbs the surge but never returns to baseline latency has still failed. A run-wide percentile would
  be dominated by the surge and would say nothing about coming back.
- **Stress has no latency threshold**, on purpose. Gating `p(99)` would fail the run at the moment it starts
  producing the answer you asked for. Read the per-stage percentiles instead. `abortOnFail` on the error rate stops
  the run once a quarter of the traffic is failing — verified: against a target returning 500s for half its
  requests, it aborted **2 seconds into a 2m15s run**.

### 6.5 `dropped_iterations` — the check that stops the run lying to you

Every arrival-rate scenario reports `dropped_iterations`: iterations k6 could not **start** on schedule. `load.ts`
and `soak.ts` gate it at zero, and it is the most valuable threshold in the file.

Verified on purpose, against a target answering in 11 ms with a 0 % error rate — a run that looks excellent:
starving the pool to 2 VUs produced `p(99)=11.46ms`, `http_req_failed 0.00%`, and **1071 dropped iterations**. The
latency figure was real and completely meaningless, because a third of the intended traffic was never sent. Without
this threshold the run passes and you quote the number.

Which is why the VU pool matters more than it looks. A VU is held for a whole iteration, and `journey()`'s think
time dominates that, so `perf/lib/flow.ts` exports `vusFor(rate)` and every scenario sizes its pool with it:

```ts
preAllocatedVUs: vusFor(PEAK_RATE); // ≈ rate × (think time + 1s of response headroom)
```

Growing the pool mid-run is slow enough to lose iterations by itself: `preAllocatedVUs: 50` at 50 req/s with a 1 s
think time dropped 2 iterations against a healthy target. `stress.ts` therefore pre-allocates for its **top** stage
even though most of the run does not need it — measured, that took allocation-lag drops from 113 to 0, which is
what lets a non-zero count there mean "the target held VUs longer than expected".

If a load run fails on `dropped_iterations`, raise `preAllocatedVUs` (or lower the think time) before you touch the
threshold. Deleting it is how you end up with a fast, wrong number.

### 6.6 Type-check it, because k6 will not

```bash
npm run typecheck:perf
```

k6 transpiles TypeScript with esbuild, which strips types and verifies **none** of them, and it resolves no
node_modules. Without this the directory is untyped JavaScript wearing a `.ts` extension. `perf/tsconfig.json` is
separate from the project's root one (which excludes `perf`) because these files use `k6/http`, `open()` and
`__ENV`, and import each other with explicit `.ts` extensions — what k6's own resolver needs. Wire
`typecheck:perf` into CI next to `type-check`; it is the whole mitigation for k6's one real drawback.

One gap it found on its first run: `@types/k6` does not declare `console`, so `perf/globals.d.ts` declares it
rather than pulling the entire DOM lib in for one global.

### 6.7 What to gate, and where

- **On a pull request:** Layer 1 (`npm run test:perf`) and `typecheck:perf`. Bytes and request counts barely move
  between runs, which is what makes them gateable on a shared runner.
- **Nightly, on a consistent machine:** `perf:load`, `perf:spike`, `perf:soak`, compared against a rolling
  baseline. Gating `p99` on a shared CI runner produces a flaky pipeline, and a flaky pipeline gets ignored, which
  is worse than no gate.
- **On demand:** `perf:stress`, when you need a capacity number.

A soak run's real output is a **time series**, not the end-of-run summary: the summary averages the healthy first
minutes with the degraded last ones and can pass a run that was visibly dying. Capture the series —
`k6 run --out json=perf-soak.json perf/soak.ts` — and look at its shape.

---

## 7. What this plugin does not do

- **No Lighthouse score.** It measures a lab score with its own throttling model, and the number moves when
  Chrome updates, which makes it a poor CI gate. Its useful signals — LCP, CLS, TBT — are read directly here,
  without the score's variance.
- **No baseline history.** Budgets are absolute numbers in your spec, and Layer 2 prints a summary per run.
  Comparing runs over time means storing k6's output somewhere (`--out json`, Prometheus) and is yours to wire.
- **No browser-level load.** k6 has a `k6/browser` module that can drive real Chromium and mix browser VUs with
  protocol VUs under one gate. It is not set up here yet.
- **No distributed load.** One machine, one k6 process. k6 supports more (a Kubernetes operator, Grafana Cloud)
  when one machine stops being the thing with headroom.
- **No `web-vitals` dependency.** The page already ships the measurement; only the two subtle algorithms (CLS
  session windows, INP grouping) needed writing, and they are unit tested.
