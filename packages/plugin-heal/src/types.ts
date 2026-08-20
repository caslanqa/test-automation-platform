/**
 * The typed run model — this repo's first. Until now the only per-result projection anywhere was
 * untyped JS in a shipped template (`plugin-appium/templates/scripts/mobile/appium-report.mjs`),
 * which aggregates per *attempt* rather than per test and therefore counts a retried failure once as
 * `failed` and once as `passed`. This model keys on {@link TestRecord.outcome} so it cannot.
 *
 * Every field here is something a later triage decision reads. Nothing is stored "in case", because
 * the record is written on every run and read on every triage.
 *
 * @example
 * const run: RunRecord = JSON.parse(fs.readFileSync('.heal/runs/2026-08-20T09-14-02Z-<id>.json', 'utf8'));
 * run.tests.filter(t => t.outcome === 'flaky');
 */

/** Bumped on any breaking change to the shapes below; readers refuse a record they cannot parse. */
export const RUN_SCHEMA = 1;

/**
 * Bumped whenever a pattern in `triage/errorTaxonomy.ts` changes. It participates in both
 * fingerprints, so a taxonomy change starts new clusters instead of silently merging old and new.
 */
export const TAXONOMY_VERSION = 1;

/**
 * What kind of failure this is, structurally. Derived from the error text and the failing step —
 * never from a model. Each value is justified by a real Playwright message; see the taxonomy table.
 */
export type ErrorKind =
  /** `strict mode violation: … resolved to N elements` — a selector that was unique no longer is. */
  | 'strict-mode'
  /** A presence matcher timed out: the element is hidden, detached, or not found at all. */
  | 'presence-timeout'
  /** An action timed out waiting for its locator. */
  | 'action-timeout'
  /** A matcher compared values and they differ. The one class that must never be auto-healed. */
  | 'value-mismatch'
  /** `toHaveCount` received 0 — ambiguous between "gone" and "genuinely empty". */
  | 'count-zero'
  /** Navigation or request failure: `net::ERR_*`, `ECONNREFUSED`, a refused `goto`. */
  | 'network'
  /** The browser, context or page died under the test. */
  | 'browser-crash'
  /** The deepest erroring step was a fixture or hook — setup failed, the test never really ran. */
  | 'fixture-error'
  /** `Test timeout of Nms exceeded.` with nothing more specific. The weakest signal there is. */
  | 'test-timeout'
  /** Recognised as a failure, but not as any of the above. */
  | 'unknown';

export interface FailureRecord {
  kind: ErrorKind;
  /** `toBeVisible`, `toHaveText`, … when the message or the failing step names one. */
  matcher?: string;
  /** The locator as the message printed it, e.g. `getByRole('button', { name: 'Log in' })`. */
  locatorCode?: string;
  /** The `Expected:` line, verbatim after ANSI stripping. */
  expected?: string;
  /** The `Received:` line, verbatim after ANSI stripping. */
  received?: string;
  timeoutMs?: number;
  /** ANSI-stripped, call log removed, capped — see `normalizeMessage`. */
  message: string;
  /** First lines of the `Call log:` block, capped. */
  callLog?: string[];
  /** First stack frame inside the project, which is the line a human should open. */
  topFrame?: { file: string; line: number };
  /** The deepest step carrying an error, and its category — `fixture` is the env-infra signal. */
  failingStep?: { title: string; category: string };
  /** "Same place, same kind of failure" — clusters flakes and repeat offenders. */
  errorFingerprint: string;
  /** As above, plus the observed values — distinguishes wrong data from wrong place. */
  siteFingerprint: string;
  taxonomyVersion: number;
  /** Paths only. A body here would put a screenshot inside the JSON. */
  attachments: Array<{ name: string; path: string }>;
}

export interface AttemptRecord {
  /** Attempt index: 0 is the first run, 1 the first retry. */
  retry: number;
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  durationMs: number;
  workerIndex: number;
  parallelIndex: number;
  /** Present only when this attempt failed. */
  failure?: FailureRecord;
}

export interface TestRecord {
  /** Our own stable cross-run key. Never `TestCase.id`, which is session-scoped. */
  testKey: string;
  /** `TestCase.id`, kept only to cross-link the HTML report. */
  pwId: string;
  project: string;
  /** POSIX, relative to the config's rootDir. */
  file: string;
  /** The title path after the file entry: describes, then the test title. */
  titlePath: string[];
  line: number;
  tags: string[];
  /**
   * `TestCase.outcome()`. **`flaky` is only knowable here** — there is no such `TestResult.status`,
   * and it is the whole flaky-versus-true-fail distinction, available for free.
   */
  outcome: 'expected' | 'unexpected' | 'flaky' | 'skipped';
  attempts: AttemptRecord[];
  annotations: Array<{ type: string; description?: string }>;
}

export interface RunRecord {
  schema: typeof RUN_SCHEMA;
  runId: string;
  shard?: { current: number; total: number };
  startedAt: string;
  durationMs: number;
  ci: boolean;
  commit?: string;
  branch?: string;
  /** `GITHUB_BASE_REF`, for diff correlation during triage. */
  baseRef?: string;
  workers: number;
  projects: string[];
  /** The config's own `retries`, so a reader knows whether a flake signal was even possible. */
  configRetries: number;
  status: 'passed' | 'failed' | 'timedout' | 'interrupted';
  /**
   * Errors from `onError` — outside any test. A worker that dies takes its `onTestEnd` with it, so
   * without this the failure is invisible; it is the env-infra evidence channel.
   */
  globalErrors: string[];
  tests: TestRecord[];
}

/** One test's rolling history, folded from run records and committed so it outlives artifacts. */
export interface BaselineEntry {
  testKey: string;
  project: string;
  file: string;
  title: string;
  /** Runs in which this test actually ran. */
  runs: number;
  fails: number;
  /** Attempts that failed and were followed by a pass in the same run. */
  passOnRetry: number;
  firstSeen: string;
  lastSeen: string;
  lastPassed?: string;
  /** Where it fails, most recent first, capped. */
  sites: Array<{ siteFingerprint: string; count: number; lastSeen: string; kind: ErrorKind }>;
}

export interface Baseline {
  schema: typeof RUN_SCHEMA;
  /** How many runs the rolling counters cover. */
  window: number;
  entries: BaselineEntry[];
}
