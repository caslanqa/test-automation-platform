/**
 * `@pwtap/plugin-perf` — Layer 1 of the performance milestone: single-user performance assertions that run
 * inside the suite you already have.
 *
 * No Playwright project of its own, deliberately, and for the same reason `plugin-db` has none: these are
 * assertions ABOUT the page a test already opened, so a separate project would get between the test and the thing
 * it is measuring. They merge into `@fixtures` and are available in every file.
 *
 * Load — the ramp shapes, arrival-rate models and threshold gates — is **Layer 2**, and none of it is importable
 * from here: it is k6 scripts, scaffolded into `perf/` and run by the k6 binary as its own command, because a load
 * generator inside the shared worker pool measures the worker pool. `docs/PERF_TESTING.md` §6 covers it.
 *
 * @example
 * import { expect, test } from '@fixtures';
 * test.use({ perfBudget: { lcp: 2500, cls: 0.1, totalBytes: 1_500_000, requests: 60 } });
 * test('the product page stays within budget', async ({ page, vitals, budget }) => {
 *   await page.goto('/products/42');
 *   await vitals.assert();
 *   await budget.assert();
 * });
 */
import { test as base, expect } from '@playwright/test';

import {
  provideBench,
  provideBudget,
  provideVitals,
  type PerfFixtures,
  type PerfOptions,
} from './fixtures.js';

export const test = base.extend<PerfFixtures & PerfOptions>({
  perfBudget: [{}, { option: true }],
  vitals: provideVitals,
  budget: provideBudget,
  bench: provideBench,
});

export {
  compareBench,
  hasBenchThreshold,
  probeTarget,
  resolveBenchUrl,
  runBench,
  type BenchBudget,
  type BenchResult,
  type BenchRunOptions,
} from './core/bench.js';
export {
  benchesSummary,
  benchSummary,
  bytes,
  ms,
  resourcesSummary,
  vitalsSummary,
} from './core/report.js';
export {
  compareResources,
  hasResourceCheck,
  totalsOf,
  type ResourceBudget,
  type ResourceRecord,
  type ResourceTotals,
} from './core/resources.js';
export {
  blockingTimeOf,
  clsOf,
  compareVitals,
  harvestVitalsInPage,
  inpOf,
  sampleOf,
  type RawVitals,
  type VitalsBudget,
  type VitalsSample,
  type VitalsVerdict,
} from './core/vitals.js';
export {
  DEFAULT_SETTLE_MS,
  type Bench,
  type CollectOptions,
  type PageBudget,
  type PageResources,
  type PerfBudget,
  type PerfFixtures,
  type PerfOptions,
  type Vitals,
} from './fixtures.js';
export { expect };
