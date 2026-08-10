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

/** What the page cost: bytes and requests, overall and per resource type. */
export interface PageBudget {
  collect(): Promise<PageResources>;
  /** Forget everything recorded so far — for a spec that measures a second navigation separately. */
  reset(): void;
  assert(budget?: ResourceBudget): Promise<PageResources>;
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

export async function provideVitals(
  { page, perfBudget }: { page: Page } & PerfOptions,
  use: (value: Vitals) => Promise<void>,
  testInfo: TestInfo,
): Promise<void> {
  const collect = async (): Promise<VitalsSample> =>
    sampleOf(await page.evaluate(harvestVitalsInPage));

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
}

export async function provideBudget(
  { page, perfBudget }: { page: Page } & PerfOptions,
  use: (value: PageBudget) => Promise<void>,
): Promise<void> {
  // `request.sizes()` is async and only resolves once the request has finished, which is why the listener is on
  // `requestfinished` rather than `response`: on `response` the sizes are not available yet.
  let pending: Array<Promise<ResourceRecord | null>> = [];

  const onFinished = (request: Request): void => {
    pending.push(
      request
        .sizes()
        .then(sizes => ({
          url: request.url(),
          resourceType: request.resourceType(),
          // Transfer size: body plus the response headers that came with it.
          bytes: sizes.responseBodySize + sizes.responseHeadersSize,
        }))
        // A request whose sizes have gone (the page navigated away while it was in flight) is dropped instead of
        // failing the test. This is accounting; it is not the thing under test.
        .catch(() => null),
    );
  };

  page.on('requestfinished', onFinished);

  const collect = async (): Promise<PageResources> => {
    const resources = (await Promise.all(pending)).filter(
      (record): record is ResourceRecord => record !== null,
    );
    return { ...totalsOf(resources), resources };
  };

  await use({
    collect,
    reset: (): void => {
      pending = [];
    },
    assert: async (budget?: ResourceBudget): Promise<PageResources> => {
      const wanted = budget ?? resourceBudgetOf(perfBudget);
      if (!hasResourceCheck(wanted)) {
        throw new Error(
          '[perf] budget.assert() has nothing to check — set perfBudget (e.g. { totalBytes: 1_500_000 }) or pass a budget',
        );
      }
      const measured = await collect();
      const failures = compareResources(measured.resources, wanted);
      if (failures.length > 0) {
        fail('resource budget exceeded', failures);
      }
      return measured;
    },
  });

  page.off('requestfinished', onFinished);
}

export async function provideBench(
  { baseURL, perfBudget }: { baseURL: string | undefined } & PerfOptions,
  use: (value: Bench) => Promise<void>,
  testInfo: TestInfo,
): Promise<void> {
  const run = async (options: BenchRunOptions = {}): Promise<BenchResult> => {
    const resolved = resolveBenchUrl(options, baseURL);
    if ('reason' in resolved) {
      skipUnavailable(testInfo, resolved.reason);
    }
    const unreachable = await probeTarget(resolved.url);
    if (unreachable !== null) {
      skipUnavailable(testInfo, unreachable);
    }
    return runBench(resolved.url, options, perfBudget.bench ?? {});
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
}
