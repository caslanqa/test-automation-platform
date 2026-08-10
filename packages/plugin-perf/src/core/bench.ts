/**
 * A single-endpoint latency benchmark, via autocannon.
 *
 * This is a BUDGET check, not a load test. It runs inside a Playwright worker, so its absolute numbers are worth
 * whatever the machine and the other workers make them worth — the defaults are small on purpose, and
 * `docs/PERF_TESTING.md` says to use `--workers=1` before quoting a figure. Load lives in Layer 2, outside the
 * runner, for the reason `docs/perf-test-plugin-plan.md` §3 gives.
 *
 * @example
 * const result = await runBench({ url: 'http://localhost:3000/health', duration: 3 });
 * expect(result.p99).toBeLessThan(200);
 */
import autocannon from 'autocannon';

/** What to benchmark, and how hard. `path` resolves against Playwright's own `baseURL`. */
export interface BenchRunOptions {
  /** An absolute URL. Wins over `path` when both are given. */
  url?: string;
  /** A path resolved against `baseURL`, so a project configures the host once. */
  path?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  /** Request body. A string is sent verbatim; set the content type in `headers`. */
  body?: string;
  /** Seconds to run. Ignored when `amount` is set. */
  duration?: number;
  /** Total requests to send instead of running for a duration — the more repeatable choice in CI. */
  amount?: number;
  /** Concurrent connections. */
  connections?: number;
  /** Cap the request rate, to measure latency at a rate rather than at saturation. */
  overallRate?: number;
}

/**
 * The measured result.
 *
 * There is no `p95`: autocannon's HDR histogram exposes p50, p75, p90, p97_5 and p99, and interpolating a p95
 * from the neighbouring buckets to match a nicer-sounding name would be inventing a number.
 */
export interface BenchResult {
  url: string;
  /** Median latency, ms. */
  p50: number;
  p90: number;
  /** The 97.5th percentile, ms — autocannon's nearest bucket to the p95 people ask for. */
  p97_5: number;
  p99: number;
  mean: number;
  max: number;
  /** Requests per second, averaged over the run. */
  rps: number;
  /** Requests attempted: responses received, plus the ones that errored or timed out without one. */
  totalRequests: number;
  /** Responses actually received, whatever their status. */
  responses: number;
  /** Socket-level failures: connection refused, reset, parse errors. */
  errors: number;
  timeouts: number;
  /** Responses outside 2xx — a fast run that rejects everything is not a fast run. */
  non2xx: number;
  /** `(errors + timeouts + non2xx) / totalRequests`, 0–1. The gate §1 says never to omit. */
  errorRate: number;
}

/** Ceilings, plus the run defaults so a spec does not repeat them. `rps` is a FLOOR, not a ceiling. */
export interface BenchBudget {
  duration?: number;
  connections?: number;
  amount?: number;
  p50?: number;
  p90?: number;
  p97_5?: number;
  p99?: number;
  /** Maximum acceptable error rate, 0–1. */
  errorRate?: number;
  /** Minimum acceptable throughput. */
  rps?: number;
}

const DEFAULT_DURATION_SECONDS = 5;
const DEFAULT_CONNECTIONS = 10;
const PROBE_TIMEOUT_MS = 5000;

/**
 * Work out what to hit, or say why it cannot be worked out.
 *
 * Returning a reason rather than throwing is deliberate: an unconfigured target must skip, and a fixture can only
 * skip with a reason it was handed.
 */
export function resolveBenchUrl(
  options: BenchRunOptions,
  baseURL: string | undefined,
): { url: string } | { reason: string } {
  if (options.url) {
    return { url: options.url };
  }
  if (!options.path) {
    return { reason: 'bench.run needs a url or a path' };
  }
  if (!baseURL) {
    return {
      reason: `bench.run({ path: '${options.path}' }) needs a baseURL — set use.baseURL in playwright.config.ts, or pass an absolute url`,
    };
  }
  try {
    return { url: new URL(options.path, baseURL).toString() };
  } catch {
    return { reason: `baseURL "${baseURL}" is not a valid URL` };
  }
}

/**
 * One request, to find out whether benchmarking is worth starting.
 *
 * Returns the reason to skip, or null to go ahead. Any HTTP response counts as reachable, including a 404: the
 * question here is whether something is listening, and a wrong path is the benchmark's business to report as
 * `non2xx`, not a reason to skip silently. Only a transport failure or a timeout skips.
 */
export async function probeTarget(
  url: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    // The body is never read, so release the socket instead of leaving it to the GC.
    await response.body?.cancel();
    return null;
  } catch (error) {
    return `could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Run the benchmark. The caller has already resolved the URL and probed it. */
export async function runBench(
  url: string,
  options: BenchRunOptions = {},
  defaults: BenchBudget = {},
): Promise<BenchResult> {
  const connections = options.connections ?? defaults.connections ?? DEFAULT_CONNECTIONS;
  const amount = options.amount ?? defaults.amount;
  const result = await autocannon({
    url,
    connections,
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body,
    overallRate: options.overallRate,
    // `amount` and `duration` are alternatives in autocannon; sending both makes the run's shape ambiguous.
    ...(amount !== undefined
      ? { amount }
      : { duration: options.duration ?? defaults.duration ?? DEFAULT_DURATION_SECONDS }),
  });

  // Counted from the per-status buckets rather than from autocannon's own `totalCompletedRequests`, which
  // `@types/autocannon` (7.x) does not declare for autocannon 8. Deriving it from typed fields is not a
  // workaround for the type lag but the more precise number: `2xx + non2xx` is exactly the responses received,
  // and errors/timeouts are attempts that never got one, so they belong in the denominator and not in it.
  const responses = result['2xx'] + result.non2xx;
  const totalRequests = responses + result.errors + result.timeouts;
  const failed = result.errors + result.timeouts + result.non2xx;
  return {
    url,
    p50: result.latency.p50,
    p90: result.latency.p90,
    p97_5: result.latency.p97_5,
    p99: result.latency.p99,
    mean: result.latency.average,
    max: result.latency.max,
    rps: result.requests.average,
    totalRequests,
    responses,
    errors: result.errors,
    timeouts: result.timeouts,
    non2xx: result.non2xx,
    // Nothing attempted at all is total failure, not a clean 0 % error rate.
    errorRate: totalRequests > 0 ? failed / totalRequests : 1,
  };
}

/** Every breached threshold, worded so the number and the budget are both visible. */
export function compareBench(result: BenchResult, budget: BenchBudget): string[] {
  const failures: string[] = [];
  for (const name of ['p50', 'p90', 'p97_5', 'p99'] as const) {
    const limit = budget[name];
    if (limit !== undefined && result[name] > limit) {
      failures.push(`${name} ${result[name].toFixed(1)} ms exceeds the ${limit} ms budget`);
    }
  }
  if (budget.errorRate !== undefined && result.errorRate > budget.errorRate) {
    failures.push(
      `error rate ${percent(result.errorRate)} exceeds the ${percent(budget.errorRate)} budget — ` +
        `${result.errors} errors, ${result.timeouts} timeouts, ${result.non2xx} non-2xx of ${result.totalRequests}`,
    );
  }
  if (budget.rps !== undefined && result.rps < budget.rps) {
    failures.push(
      `throughput ${result.rps.toFixed(0)} req/s is below the ${budget.rps} req/s floor`,
    );
  }
  return failures;
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}
