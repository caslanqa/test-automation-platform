/**
 * The `perfBudget` option and the three Layer 1 fixtures: `vitals`, `budget`, `bench`.
 *
 * All three follow the same contract, which is the platform's rule everywhere else applied to performance:
 * a budget that is **breached fails**, a budget that **cannot be measured skips** with the reason. So a spec
 * asserting LCP does not fail on WebKit, and a spec benchmarking an endpoint does not fail when nothing is
 * listening — it says so and moves on, exactly as an absent device or an unreachable database does.
 *
 * Budgets live in the option rather than in each spec, so the numbers are stated once per file and a spec reads
 * as intent. An explicit argument to `assert()` still wins.
 *
 * The bodies are exported as plain functions so `index.ts` can assemble one `base.extend` with no casts.
 *
 * @example
 * test.use({ perfBudget: { lcp: 2500, cls: 0.1, totalBytes: 1_500_000 } });
 * test('the page stays in budget', async ({ page, vitals, budget }) => {
 *   await page.goto('/');
 *   await vitals.assert();
 *   await budget.assert();
 * });
 */
import type { Page, Request, TestInfo } from '@playwright/test';

import {
  compareBench,
  hasBenchThreshold,
  probeTarget,
  resolveBenchUrl,
  runBench,
  type BenchBudget,
  type BenchResult,
  type BenchRunOptions,
} from './core/bench.js';
import { benchesSummary, resourcesSummary, vitalsSummary } from './core/report.js';
import {
  compareResources,
  hasResourceCheck,
  totalsOf,
  type ResourceBudget,
  type ResourceRecord,
  type ResourceTotals,
} from './core/resources.js';
import {
  compareVitals,
  harvestVitalsInPage,
  sampleOf,
  type VitalsBudget,
  type VitalsSample,
} from './core/vitals.js';
import { skipWithReason } from './skip.js';

/** Every budget a spec can set, in one option. */
export interface PerfBudget extends VitalsBudget, ResourceBudget {
  /** Thresholds AND run defaults for `bench` — see {@link BenchBudget}. */
  bench?: BenchBudget;
}

export interface PerfOptions {
  perfBudget: PerfBudget;
}

/** Core Web Vitals and navigation timing for the current page. */
export interface Vitals {
  /** Read the page's performance timeline. Call it once the page is in the state you want measured. */
  collect(): Promise<VitalsSample>;
  /** Collect, then check against `perfBudget` (or the argument). Returns the sample for further assertions. */
  assert(budget?: VitalsBudget): Promise<VitalsSample>;
}

/** Totals plus the individual requests behind them, so a custom check does not have to re-collect. */
export interface PageResources extends ResourceTotals {
  resources: ResourceRecord[];
}

export interface CollectOptions {
  /**
   * How long to wait for the network to go quiet before reading, in ms. `0` reads immediately.
   *
   * Defaults to {@link DEFAULT_SETTLE_MS}. Raise it for a page that keeps loading for longer than that; a page with
   * a websocket or polling never goes quiet, and the wait simply expires and measures what has arrived.
   */
  settleMs?: number;
}

/** What the page cost: bytes and requests, overall and per resource type. */
export interface PageBudget {
  collect(options?: CollectOptions): Promise<PageResources>;
  /** Forget everything recorded so far — for a spec that measures a second navigation separately. */
  reset(): void;
  assert(budget?: ResourceBudget, options?: CollectOptions): Promise<PageResources>;
}

/** A single-endpoint latency benchmark. Not a load test: see `core/bench.ts`. */
export interface Bench {
  run(options?: BenchRunOptions): Promise<BenchResult>;
  /** Run, then check against `perfBudget.bench` (or the argument). Returns the result. */
  assert(options?: BenchRunOptions, budget?: BenchBudget): Promise<BenchResult>;
}

export interface PerfFixtures {
  vitals: Vitals;
  budget: PageBudget;
  bench: Bench;
}

/** The vitals keys, so a combined `perfBudget` is not handed resource keys to look up as metrics. */
const VITALS_KEYS = [
  'ttfb',
  'fcp',
  'lcp',
  'cls',
  'inp',
  'tbt',
  'longTasks',
  'domContentLoaded',
  'load',
] as const;

function vitalsBudgetOf(budget: PerfBudget): VitalsBudget {
  const picked: VitalsBudget = {};
  for (const key of VITALS_KEYS) {
    if (budget[key] !== undefined) {
      picked[key] = budget[key];
    }
  }
  return picked;
}

function resourceBudgetOf(budget: PerfBudget): ResourceBudget {
  const { totalBytes, requests, byType } = budget;
  return { totalBytes, requests, byType };
}

/**
 * True when nothing was budgeted — asserting an empty budget would silently pass and mean nothing.
 *
 * Sound for {@link VitalsBudget}, whose every field is a plain number. It is NOT sound for a budget holding a
 * nested object or run parameters, which is why `hasResourceCheck` and `hasBenchThreshold` live in `core/` beside
 * the comparisons they guard — and are tested there.
 */
function isEmptyBudget(budget: object): boolean {
  return Object.values(budget).every(value => value === undefined);
}

function fail(what: string, failures: string[]): never {
  throw new Error(`[perf] ${what}:\n  - ${failures.join('\n  - ')}`);
}

/**
 * Abort the test as skipped.
 *
 * `testInfo.skip(true, …)` aborts by throwing, so the `throw` below never runs; it is here to give this function
 * a `never` return type, which is what lets `bench.run` return `Promise<BenchResult>` without an unreachable
 * fallback value.
 */
function skipUnavailable(testInfo: TestInfo, reason: string): never {
  skipWithReason(testInfo, `[perf] ${reason}`);
  throw new Error(reason);
}

/**
 * Put the headline numbers next to the test in the report.
 *
 * Written at measurement time rather than at teardown, because an annotation added during teardown is not reliably
 * part of the result the reporters read. Repeated measurements UPDATE the same row instead of appending, so a spec
 * that navigates twice does not leave a trail of stale numbers — the last measurement is the one that describes the
 * test.
 */
function annotate(testInfo: TestInfo, type: string, description: string): void {
  const existing = testInfo.annotations.find(annotation => annotation.type === type);
  if (existing) {
    existing.description = description;
    return;
  }
  testInfo.annotations.push({ type, description });
}

/**
 * Attach the full measurement as JSON.
 *
 * At teardown, so it happens exactly once per fixture per test and — the part that matters — **also when the test
 * failed**, which is the run whose numbers someone actually needs. Machine-readable on purpose: a rolling baseline,
 * or a "which page grew" query across a run, wants `test-results/` JSON rather than a scraped console line.
 */
async function attachJson(testInfo: TestInfo, name: string, data: unknown): Promise<void> {
  await testInfo.attach(name, {
    body: JSON.stringify(data, null, 2),
    contentType: 'application/json',
  });
}

/** Long enough for the fonts and images a page pulls in after `load`; short enough not to stall a suite. */
export const DEFAULT_SETTLE_MS = 2000;
/** How long nothing may be in flight before the page counts as quiet — enough for one request to chain another. */
const QUIET_MS = 150;
/** How often to look while requests are still in flight. */
const POLL_MS = 50;

export async function provideVitals(
  { page, perfBudget }: { page: Page } & PerfOptions,
  use: (value: Vitals) => Promise<void>,
  testInfo: TestInfo,
): Promise<void> {
  let measured: VitalsSample | undefined;

  const collect = async (): Promise<VitalsSample> => {
    measured = sampleOf(await page.evaluate(harvestVitalsInPage));
    annotate(testInfo, 'perf:vitals', vitalsSummary(measured));
    return measured;
  };

  await use({
    collect,
    assert: async (budget?: VitalsBudget): Promise<VitalsSample> => {
      const wanted = budget ?? vitalsBudgetOf(perfBudget);
      if (isEmptyBudget(wanted)) {
        throw new Error(
          '[perf] vitals.assert() has nothing to check — set perfBudget (e.g. { lcp: 2500 }) or pass a budget',
        );
      }
      const sample = await collect();
      const { failures, unmeasurable } = compareVitals(sample, wanted);
      // A real breach is reported even when another metric was unmeasurable: skipping here would hide it.
      if (failures.length > 0) {
        fail('web vitals budget exceeded', failures);
      }
      if (unmeasurable.length > 0) {
        skipUnavailable(testInfo, unmeasurable.join('; '));
      }
      return sample;
    },
  });

  if (measured) {
    await attachJson(testInfo, 'perf-vitals.json', measured);
  }
}

export async function provideBudget(
  { page, perfBudget }: { page: Page } & PerfOptions,
  use: (value: PageBudget) => Promise<void>,
  testInfo: TestInfo,
): Promise<void> {
  /**
   * Requests that have started and not yet settled, each with the resolver that releases its record.
   *
   * Tracking starts rather than finishes is what makes `collect()` deterministic. **`page.waitForLoadState`
   * ('networkidle') does not work here**, which took a real page to discover: after a navigation's load lifecycle has
   * gone idle, calling it again resolves IMMEDIATELY, so the six images saucedemo starts lazily after `load` were
   * traced as `start image ×6` with not one `finish` — and `collect()` reported 0 requests and 0 bytes while the test
   * happily passed a "less than three times the landing page" assertion. Requests started after the load lifecycle
   * ends are exactly the ones a resource budget is for.
   */
  const inFlight = new Map<Request, () => void>();
  let pending: Array<{ request: Request; record: Promise<ResourceRecord | null> }> = [];

  const onRequest = (request: Request): void => {
    let settle = (): void => {};
    const settled = new Promise<void>(resolve => {
      settle = resolve;
    });
    inFlight.set(request, settle);
    pending.push({
      request,
      record: settled
        // `sizes()` is only valid once the request has settled, which is what `settled` waits for.
        .then(async () => {
          const sizes = await request.sizes();
          return {
            url: request.url(),
            resourceType: request.resourceType(),
            // Transfer size: body plus the response headers that came with it.
            bytes: sizes.responseBodySize + sizes.responseHeadersSize,
          };
        })
        // A request that failed, or whose sizes have gone because the page navigated away mid-flight, is dropped
        // rather than failing the test. This is accounting; it is not the thing under test.
        .catch(() => null),
    });
  };

  const onSettled = (request: Request): void => {
    inFlight.get(request)?.();
    inFlight.delete(request);
  };

  page.on('request', onRequest);
  page.on('requestfinished', onSettled);
  page.on('requestfailed', onSettled);

  /**
   * Wait until nothing is in flight and nothing new has started for a beat.
   *
   * Bounded, because a page with polling or a websocket never goes quiet: when the budget expires we measure what
   * arrived instead of hanging. The quiet beat matters as much as the emptiness — one request routinely starts
   * another (a stylesheet pulls a font), and returning the instant the map empties would miss the second wave.
   */
  const settleNetwork = async (settleMs: number): Promise<void> => {
    const deadline = Date.now() + settleMs;
    while (Date.now() < deadline) {
      if (inFlight.size > 0) {
        await page.waitForTimeout(POLL_MS);
        continue;
      }
      await page.waitForTimeout(QUIET_MS);
      if (inFlight.size === 0) {
        return;
      }
    }
  };

  let measured: PageResources | undefined;

  const collect = async (options: CollectOptions = {}): Promise<PageResources> => {
    await settleNetwork(options.settleMs ?? DEFAULT_SETTLE_MS);
    // Only what has actually settled is read. A record resolves on `requestfinished` / `requestfailed`, so awaiting
    // one that is still open would outlast the bounded wait and, on a page with polling or a websocket, never
    // return — the hang the settle budget exists to prevent. Anything still in flight stays in `pending` and is
    // counted by the next `collect()` if it arrives by then.
    const settled = pending
      .filter(entry => !inFlight.has(entry.request))
      .map(entry => entry.record);
    const resources = (await Promise.all(settled)).filter(
      (record): record is ResourceRecord => record !== null,
    );
    measured = { ...totalsOf(resources), resources };
    annotate(testInfo, 'perf:resources', resourcesSummary(measured));
    return measured;
  };

  await use({
    collect,
    reset: (): void => {
      // Only the collected records are forgotten. Anything still in flight keeps its entry in `inFlight`, so a later
      // `collect()` still waits for it rather than reading a half-loaded page — its record just lands in the array
      // that was replaced, which is what "forget everything so far" means.
      pending = [];
    },
    assert: async (budget?: ResourceBudget, options?: CollectOptions): Promise<PageResources> => {
      const wanted = budget ?? resourceBudgetOf(perfBudget);
      if (!hasResourceCheck(wanted)) {
        throw new Error(
          '[perf] budget.assert() has nothing to check — set perfBudget (e.g. { totalBytes: 1_500_000 }) or pass a budget',
        );
      }
      const totals = await collect(options);
      const failures = compareResources(totals.resources, wanted);
      if (failures.length > 0) {
        fail('resource budget exceeded', failures);
      }
      return totals;
    },
  });

  page.off('request', onRequest);
  page.off('requestfinished', onSettled);
  page.off('requestfailed', onSettled);
  if (measured) {
    // The whole per-request list, not just the totals: "which dependency grew" is answered by the rows, and a
    // reader who has the JSON never has to re-run with the network tab open.
    await attachJson(testInfo, 'perf-resources.json', measured);
  }
}

export async function provideBench(
  { baseURL, perfBudget }: { baseURL: string | undefined } & PerfOptions,
  use: (value: Bench) => Promise<void>,
  testInfo: TestInfo,
): Promise<void> {
  const measured: BenchResult[] = [];

  const run = async (options: BenchRunOptions = {}): Promise<BenchResult> => {
    const resolved = resolveBenchUrl(options, baseURL);
    if ('reason' in resolved) {
      skipUnavailable(testInfo, resolved.reason);
    }
    const unreachable = await probeTarget(resolved.url);
    if (unreachable !== null) {
      skipUnavailable(testInfo, unreachable);
    }
    const result = await runBench(resolved.url, options, perfBudget.bench ?? {});
    // Appended, not replaced: benchmarking two endpoints in one test is a normal thing to do, and the summary line
    // names each one rather than pretending the last is the whole story.
    measured.push(result);
    annotate(testInfo, 'perf:bench', benchesSummary(measured));
    return result;
  };

  await use({
    run,
    assert: async (options?: BenchRunOptions, budget?: BenchBudget): Promise<BenchResult> => {
      const wanted = budget ?? perfBudget.bench ?? {};
      if (!hasBenchThreshold(wanted)) {
        throw new Error(
          '[perf] bench.assert() has nothing to check — set perfBudget.bench (e.g. { p99: 800, errorRate: 0 }) or pass a budget',
        );
      }
      const result = await run(options);
      const failures = compareBench(result, wanted);
      if (failures.length > 0) {
        fail(`bench budget exceeded for ${result.url}`, failures);
      }
      return result;
    },
  });

  if (measured.length > 0) {
    await attachJson(testInfo, 'perf-bench.json', measured);
  }
}
