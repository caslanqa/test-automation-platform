/**
 * Performance budgets, in the shapes they actually take on a real project.
 *
 * Run with `npm run test:perf`, which pins `--workers=1`: `bench` shares the worker pool with every other test, so a
 * percentile measured while five browsers are running is a number about your machine.
 *
 * **Every number below is deliberately loose.** They are set to pass against the scaffold's demo `BASE_URL` on an
 * ordinary laptop, which is not a meaningful target for your app. The workflow is: measure first, then set the
 * ceiling just above what you are willing to accept. A budget nobody can breach is documentation, not a test — and
 * you do not have to guess, because every run writes its numbers into the report (see the end of this file).
 *
 * Named `.spec.ts` because the core scaffold collects `.spec.ts` and `.test.ts`, and this plugin adds no project of
 * its own — that is the point: these are assertions about pages your suite already opens.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@fixtures';

// Set once per file, so each test states intent instead of repeating magic numbers. `assert()` with no argument
// checks exactly these; pass a budget explicitly to override one call.
test.use({
  perfBudget: {
    // The Core Web Vitals "good" field thresholds are lcp 2500, cls 0.1, inp 200. A CI runner is not a user's
    // phone, so treat these as regression detection against your own baseline, not as field measurement.
    lcp: 6000,
    cls: 0.25,
    ttfb: 4000,
    // Bytes and request counts barely move between runs, which is what makes them the budgets worth gating on a
    // shared runner. Tighten these first.
    totalBytes: 5_000_000,
    requests: 80,
    bench: { p99: 2000, errorRate: 0, connections: 5, amount: 200 },
  },
});

test('the landing page stays inside its web-vitals budget', async ({ page, vitals }) => {
  await page.goto('/', { waitUntil: 'load' });

  // Collect once the page is in the state you want measured — LCP keeps being revised upward until the user
  // interacts. `assert()` has already failed on anything over budget; the sample comes back so a spec can add its
  // own checks, and the numbers are in the report either way.
  const measured = await vitals.assert();

  // A budget catches a ceiling. This catches a shape: a page whose largest paint arrives long after its first one
  // is rendering its real content late, however comfortable both numbers look on their own.
  if (measured.fcp !== undefined && measured.lcp !== undefined) {
    expect(measured.lcp - measured.fcp).toBeLessThan(3000);
  }
});

test('the landing page stays inside its resource budget', async ({ page, budget }) => {
  await page.goto('/', { waitUntil: 'load' });

  await budget.assert();

  // Per-type budgets catch the regression that actually happens: someone adds a dependency and the bundle grows.
  // A total-bytes budget hides that behind whatever headroom the images left.
  await budget.assert({ byType: { script: 4_000_000, image: 4_000_000 } });
});

/**
 * The shape most real performance specs take: a journey, with each step measured on its own.
 *
 * One page in isolation tells you about your entry point. What users complain about is the step AFTER it — the route
 * that ships a second copy of a chart library, or the click that blocks the main thread for a second.
 */
test('a journey measures each step on its own, not cumulatively', async ({
  page,
  vitals,
  budget,
}) => {
  await page.goto('/', { waitUntil: 'load' });
  const landing = await budget.collect();
  await vitals.assert();

  // `reset()` forgets what has been recorded, so the next step is measured on its own rather than added to the step
  // before it. Without it every page of a journey looks heavier than the last, and the numbers say nothing.
  budget.reset();

  // A real interaction, which is also the only way INP can be measured — there is nothing to observe otherwise.
  await page.locator('#user-name').fill('standard_user');
  await page.locator('#password').fill('secret_sauce');
  await page.locator('#login-button').click();
  await page.waitForURL('**/inventory.html');

  const inventory = await budget.collect();
  const measured = await vitals.collect();

  // For a step after the first, the useful assertion is usually RELATIVE: a route costing several times the entry
  // point is worth knowing about, and the number to compare against is measured rather than guessed.
  expect(inventory.totalBytes).toBeLessThan(landing.totalBytes * 3);

  // `inp` is defined only when an interaction was slow enough to be recorded — the browser buffers event timing
  // above roughly 104 ms — so it is gated CONDITIONALLY here rather than through `perfBudget`. A budget naming
  // `inp` would skip this whole test on a fast machine, and skipping is not passing.
  if (measured.inp !== undefined) {
    expect(measured.inp).toBeLessThan(1000);
  }
  // Navigation timing is always there, whatever the interaction did.
  expect(measured.ttfb).toBeDefined();
});

test('an endpoint stays inside its latency budget', async ({ bench }) => {
  // A loopback server, so this example benchmarks nothing but this machine. Pointing a benchmark at a public demo
  // site would be rude, and pointing it at staging is a decision only you can make.
  const server = http.createServer((_request, response) => response.end('ok'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    // In a real spec this is the whole test:
    //   const result = await bench.assert({ path: '/api/health' });
    // `path` resolves against `baseURL`, so the host is configured once in env/environments.json. Add `method`,
    // `headers` and `body` for anything that is not a plain GET.
    const result = await bench.assert({ url: `http://127.0.0.1:${port}/` });

    // There is no p95: autocannon's histogram has no p95 bucket, and interpolating one would invent a number.
    // `errorRate` is gated by perfBudget above, and gating it is not optional — a run that rejects half its
    // requests reports excellent latency.
    expect(result.errorRate).toBe(0);
    // Percentiles are ordered by definition; asserting it catches a misread field name rather than a slow service.
    expect(result.p99).toBeGreaterThanOrEqual(result.p50);
  } finally {
    server.close();
  }
});

// WHERE THE NUMBERS GO
//
// Every fixture writes what it measured into the run, so nothing depends on reading stdout:
//
//   • a one-line annotation next to the test in the HTML report —
//       perf:vitals     lcp 508ms · cls 0.002 · ttfb 129ms
//       perf:resources  12 requests · 1.24 MB (script 900 kB, image 240 kB)
//       perf:bench      p50 1.2ms · p97.5 3ms · p99 12ms · 850 req/s · 0.00% errors
//   • the full measurement as an attachment — `perf-vitals.json`, `perf-resources.json`, `perf-bench.json`.
//     `perf-resources.json` lists every request with its transfer size, which is how you answer "what grew"
//     without re-running with the network tab open.
//
// Both are written even when the test FAILED, which is the run whose numbers you actually need. Open them with
// `npx playwright show-report`, or read `test-results/results.json` in CI to track a trend.
//
// SKIPS, NOT FAILURES
//
// An unreachable endpoint, or a metric this browser cannot produce, skips with the reason:
//
//   test('a service that is not running skips', async ({ bench }) => {
//     await bench.run({ url: 'http://127.0.0.1:1/health' }); // ↷ skipped — [perf] could not reach …
//   });
//
// `cls`, `tbt` and `longTasks` need layout-shift/longtask entries, which only Chromium reports, so those budgets
// skip on WebKit and Firefox. Everything else — including `lcp` and `inp`, which are often wrongly described as
// Chromium-only — is reported by all three of Playwright's browsers.
