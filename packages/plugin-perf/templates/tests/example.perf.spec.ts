/**
 * Performance budgets, in the three shapes they take.
 *
 * Run them with `npm run test:perf`, which pins `--workers=1`: `bench` shares the worker pool with every other
 * test, so a percentile measured while five browsers are running is a number about your machine.
 *
 * The budgets below are deliberately loose — they are set to pass against the scaffold's demo `BASE_URL` on an
 * ordinary laptop, which is not a meaningful target for your app. Replace them with your own numbers: measure
 * first (`vitals.collect()`, `budget.collect()`), then set the ceiling just above what you are willing to accept.
 * A budget nobody can breach is documentation, not a test.
 *
 * Named `.spec.ts` because the core scaffold collects `.spec.ts` and `.test.ts`, and this plugin adds no project
 * of its own — that is the point: these are assertions about a page your suite already opens.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@fixtures';

// Set once per file so each test reads as intent rather than as a list of magic numbers. `assert()` with no
// argument checks exactly these; pass a budget explicitly to override one test.
test.use({
  perfBudget: {
    // Core Web Vitals. The "good" field thresholds are lcp 2500, cls 0.1, inp 200 — but a CI runner is not a
    // user's phone, so these catch REGRESSIONS against themselves, not real-world experience.
    lcp: 6000,
    cls: 0.25,
    ttfb: 4000,
    // Resource budgets. These are the stable ones: bytes and request counts barely move between runs, which is
    // why they are the budgets worth gating on a shared CI runner.
    totalBytes: 5_000_000,
    requests: 80,
    bench: { p99: 2000, errorRate: 0, connections: 5, amount: 200 },
  },
});

test('the landing page stays inside its web-vitals budget', async ({ page, vitals }) => {
  await page.goto('/', { waitUntil: 'load' });

  // Collect once the page is in the state you want measured; LCP keeps updating until the user interacts.
  const measured = await vitals.assert();

  // `assert()` already failed on anything over budget. The sample is returned so a spec can add its own checks,
  // or log the numbers while deciding what the budget should be.
  console.info(
    `lcp=${measured.lcp?.toFixed(0)}ms cls=${measured.cls?.toFixed(3)} ttfb=${measured.ttfb?.toFixed(0)}ms`,
  );
});

test('the landing page stays inside its resource budget', async ({ page, budget }) => {
  await page.goto('/', { waitUntil: 'load' });

  const measured = await budget.assert();
  console.info(`${measured.requests} requests, ${(measured.totalBytes / 1_000_000).toFixed(2)} MB`);

  // Per-type budgets catch the specific regression that matters most: the bundle that quietly grew.
  await budget.assert({ byType: { script: 4_000_000 } });
});

test('an endpoint stays inside its latency budget', async ({ bench }) => {
  // A loopback server, so this example benchmarks nothing but this machine. Pointing a benchmark at a public
  // demo site would be rude, and pointing it at staging is a decision only you can make — see below.
  const server = http.createServer((_request, response) => response.end('ok'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    // In a real spec this is the whole test:
    //   const result = await bench.assert({ path: '/api/health' });
    // `path` resolves against `baseURL`, so the host is configured once in env/environments.json.
    const result = await bench.assert({ url: `http://127.0.0.1:${port}/` });

    // There is no p95: autocannon's histogram has no p95 bucket, and interpolating one would invent a number.
    console.info(
      `p50=${result.p50}ms p97.5=${result.p97_5}ms p99=${result.p99}ms rps=${result.rps.toFixed(0)}`,
    );
    // Always gate the error rate next to a latency threshold — a fast run that rejects half its requests is
    // not a fast run. `perfBudget.bench.errorRate: 0` above is that gate.
    expect(result.errorRate).toBe(0);
  } finally {
    server.close();
  }
});

// An unreachable endpoint, or a metric this browser cannot produce, SKIPS with the reason rather than failing:
//
//   test('a service that is not running skips', async ({ bench }) => {
//     await bench.run({ url: 'http://127.0.0.1:1/health' }); // ↷ skipped — [perf] could not reach …
//   });
//
// `cls`, `tbt` and `longTasks` need layout-shift/longtask entries, which only Chromium reports, so those budgets
// skip on WebKit and Firefox. Everything else — including `lcp` and `inp`, which are often wrongly described as
// Chromium-only — is reported by all three of Playwright's browsers.
