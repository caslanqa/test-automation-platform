/**
 * The run recorder — this repo's first custom Playwright reporter, and the only place several facts
 * are observable at all.
 *
 * Five hooks, and the ones left out matter as much as the ones implemented:
 *
 * | Hook | Why |
 * |---|---|
 * | `onBegin` | project root, shard, workers, projects, config retries; load the quarantine list |
 * | `onTestEnd` | one `AttemptRecord` per attempt. **Green path does no string work and no I/O** |
 * | `onError` | a worker that dies takes its `onTestEnd` with it; without this the failure is invisible |
 * | `onEnd` | `TestCase.outcome()` — the only place `flaky` is knowable — then one write |
 * | `printsToStdio` → false | we do not own the terminal; `list` keeps its live output |
 *
 * Not implemented on purpose: `onStepBegin`/`onStepEnd` (thousands of calls per run — `result.steps`
 * is read lazily in `onTestEnd`, and only for failures), `onStdOut`/`onStdErr` (per chunk, and
 * `TestResult.stdout` is already accumulated), `onExit` (nothing to flush).
 *
 * **Invariant: this reporter fails open.** Every hook body is wrapped, a malformed quarantine file
 * disables shielding rather than throwing, and nothing here ever turns a pass into a failure. The
 * one thing it may do is *suppress* an exit status, and only for a test explicitly listed.
 *
 * @example
 * // playwright.config.ts
 * reporter: [['list'], ['@pwtap/plugin-heal/reporter', { runsDir: '.heal/runs' }]]
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
  TestStep,
} from '@playwright/test/reporter';

import { DEFAULT_KEEP, pruneRuns, RUNS_DIR, writeRun } from './history/runStore.js';
import { testKey, titlePathAfterFile } from './history/testKey.js';
import { loadQuarantine, type QuarantineEntry } from './quarantine/file.js';
import { daysLeft, decideShield } from './quarantine/shield.js';
import { callLogLines, displayMessage, stripAnsi } from './triage/ansi.js';
import { classifyError } from './triage/errorTaxonomy.js';
import { errorFingerprint, siteFingerprint } from './triage/fingerprint.js';
import {
  RUN_SCHEMA,
  TAXONOMY_VERSION,
  type AttemptRecord,
  type FailureRecord,
  type RunRecord,
  type TestRecord,
} from './types.js';

export interface HealReporterOptions {
  /** Where run records go, relative to the project root. */
  runsDir?: string;
  /** How many run records to keep. */
  keep?: number;
  /** Set false to record without ever suppressing an exit status. */
  shield?: boolean;
}

const MAX_CALL_LOG = 20;

/** The deepest step carrying an error — `fixture`/`hook` there is the env-infra discriminator. */
function deepestErroringStep(steps: readonly TestStep[]): TestStep | undefined {
  let found: TestStep | undefined;
  const walk = (list: readonly TestStep[]): void => {
    for (const step of list) {
      if (step.error !== undefined) {
        found = step;
      }
      walk(step.steps);
    }
  };
  walk(steps);
  return found;
}

/** The first stack frame inside the project — the line a human should actually open. */
function topFrameIn(
  error: TestError | undefined,
  projectRoot: string,
): { file: string; line: number } | undefined {
  if (error?.location !== undefined) {
    return { file: toPosixRelative(error.location.file, projectRoot), line: error.location.line };
  }
  const stack = stripAnsi(error?.stack ?? '');
  for (const line of stack.split('\n')) {
    const match = /\(?((?:\/|[A-Za-z]:\\)[^():]+):(\d+):\d+\)?/.exec(line);
    const file = match?.[1];
    if (
      file !== undefined &&
      file.startsWith(projectRoot) &&
      !file.includes(`${path.sep}node_modules${path.sep}`)
    ) {
      return { file: toPosixRelative(file, projectRoot), line: Number(match?.[2]) };
    }
  }
  return undefined;
}

function toPosixRelative(file: string, projectRoot: string): string {
  const relative = path.relative(projectRoot, file);
  return (relative === '' ? path.basename(file) : relative).split(path.sep).join('/');
}

function gitValue(args: string[], cwd: string): string | undefined {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const value = out.trim();
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

const envOr = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
};

/**
 * Failing open is right — a bookkeeping bug must never change a run's verdict — but a reporter that
 * swallows its own errors in silence is undebuggable, and the first thing that went wrong here was
 * invisible for exactly that reason. `HEAL_DEBUG=1` surfaces what was swallowed, on stderr, without
 * changing behaviour.
 */
function swallowed(where: string, error: unknown): void {
  if (envOr('HEAL_DEBUG') === undefined) {
    return;
  }
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[heal:debug] ${where} failed and was ignored:\n${detail}\n`);
}

class HealReporter implements Reporter {
  private readonly options: HealReporterOptions;
  /**
   * The project root — where `.heal/` and `heal/` live, and what every recorded path is relative to.
   *
   * **Not `FullConfig.rootDir`.** That is the common base directory of the *tests*: for a config with
   * `testDir: './tests'` it is `<project>/tests`, so using it here wrote run records into
   * `tests/.heal/runs` and looked for the quarantine list in `tests/heal/`. Only a real run caught
   * it. The config file's own directory is the project root, and Playwright runs from there.
   */
  private projectRoot = process.cwd();
  /**
   * Fixed at construction rather than at `onEnd`, because the failing path needs it to name the
   * directory it copies error contexts into, and that happens long before the record is written.
   */
  private readonly runId = randomUUID();
  private suite: Suite | undefined;
  private readonly attempts = new Map<string, AttemptRecord[]>();
  private readonly globalErrors: string[] = [];
  private quarantine: QuarantineEntry[] = [];
  private quarantineProblem: string | undefined;
  private started = Date.now();
  private config: {
    workers: number;
    projects: string[];
    retries: number;
    shard?: { current: number; total: number };
  } = { workers: 1, projects: [], retries: 0 };

  constructor(options: HealReporterOptions = {}) {
    this.options = options;
  }

  /** We print one short block at the end, and never own the terminal. */
  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    try {
      this.started = Date.now();
      this.suite = suite;
      this.projectRoot =
        config.configFile === undefined ? process.cwd() : path.dirname(config.configFile);
      this.config = {
        workers: config.workers,
        projects: config.projects.map(project => project.name),
        retries: config.projects[0]?.retries ?? 0,
        shard: config.shard ?? undefined,
      };
      const loaded = loadQuarantine(this.projectRoot);
      this.quarantine = loaded.file.entries;
      this.quarantineProblem = loaded.problem;
    } catch (error) {
      swallowed('onBegin', error);
      // A reporter that throws in onBegin takes the whole run with it. Record nothing instead.
      this.suite = undefined;
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    try {
      const key = this.keyFor(test);
      const attempt: AttemptRecord = {
        retry: result.retry,
        // A test that never ran reports workerIndex -1; recording it as its nominal status would
        // count it as evidence.
        status: result.workerIndex === -1 ? 'skipped' : result.status,
        durationMs: result.duration,
        workerIndex: result.workerIndex,
        parallelIndex: result.parallelIndex,
      };
      // The green path stops here: four numbers and a string, no parsing, no I/O.
      if (result.status !== 'passed' && result.status !== 'skipped') {
        attempt.failure = this.failureOf(result, test);
      }
      const list = this.attempts.get(key);
      if (list === undefined) {
        this.attempts.set(key, [attempt]);
      } else {
        list.push(attempt);
      }
    } catch (error) {
      swallowed('onTestEnd', error);
      // Losing one attempt is better than derailing the run.
    }
  }

  onError(error: TestError): void {
    try {
      this.globalErrors.push(displayMessage(error.message ?? error.value ?? String(error), 1024));
    } catch {
      this.globalErrors.push('an error outside any test could not be read');
    }
  }

  // Declared async because the interface allows a Promise or void, not a bare object — and the
  // runner awaits it either way.
  async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] } | undefined> {
    try {
      return this.finish(result);
    } catch (error) {
      swallowed('onEnd', error);
      // Never change the run's verdict because our own bookkeeping failed.
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------------------------

  private keyFor(test: TestCase): string {
    const file = toPosixRelative(test.location.file, this.projectRoot);
    return testKey(this.projectOf(test), file, titlePathAfterFile(test.titlePath(), file));
  }

  private projectOf(test: TestCase): string {
    // `titlePath()` is ['', project, file, …]; the project entry is the reliable source, and it is
    // an empty string for a config with no named projects.
    return test.titlePath()[1] ?? '';
  }

  private failureOf(result: TestResult, test: TestCase): FailureRecord {
    const error = result.errors[0];
    const raw = error?.message ?? error?.value ?? '';
    const step = deepestErroringStep(result.steps);
    const facts = classifyError({
      message: raw,
      status: result.status,
      failingStepCategory: step?.category,
      failingStepTitle: step?.title,
    });
    const topFrame = topFrameIn(error, this.projectRoot);
    const site = siteFingerprint({
      kind: facts.kind,
      matcher: facts.matcher,
      locatorCode: facts.locatorCode,
      topFrame,
    });
    return {
      kind: facts.kind,
      matcher: facts.matcher,
      locatorCode: facts.locatorCode,
      expected: facts.expected,
      received: facts.received,
      timeoutMs: facts.timeoutMs,
      message: displayMessage(raw),
      callLog: callLogLines(raw, MAX_CALL_LOG),
      topFrame,
      failingStep: step === undefined ? undefined : { title: step.title, category: step.category },
      siteFingerprint: site,
      errorFingerprint: errorFingerprint({
        kind: facts.kind,
        matcher: facts.matcher,
        locatorCode: facts.locatorCode,
        topFrame,
        expected: facts.expected,
        received: facts.received,
        message: raw,
        rootDir: this.projectRoot,
      }),
      taxonomyVersion: TAXONOMY_VERSION,
      // Paths only. A Buffer body here would put a screenshot inside the JSON record.
      attachments: result.attachments
        .filter(attachment => attachment.path !== undefined)
        .map(attachment => ({
          name: attachment.name,
          path: this.keepContext(attachment, test),
        })),
    };
  }

  /**
   * Copy the `error-context` attachment next to the run record, and point the record at the copy.
   *
   * Playwright clears the output directory at the start of every run, so the ARIA snapshot a failure
   * captured is deleted by the **next** run — including the verification run `heal propose` performs.
   * Without this copy a second `propose` against the same record finds nothing, and, worse, uploading
   * `.heal/runs` as a CI artifact ships records whose evidence is in a directory that was not uploaded.
   *
   * Only `error-context` is copied. It is a few kilobytes of text; a trace or a video is not ours to
   * duplicate, and those are already in the report the user has.
   */
  private keepContext(attachment: { name: string; path?: string }, test: TestCase): string {
    const source = attachment.path as string;
    if (attachment.name !== 'error-context') {
      return toPosixRelative(source, this.projectRoot);
    }
    try {
      const runsDir = path.resolve(this.projectRoot, this.options.runsDir ?? RUNS_DIR);
      const dir = path.join(runsDir, `${this.runId}-context`);
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `${this.keyFor(test)}-${test.results.length}.md`);
      fs.copyFileSync(source, target);
      return toPosixRelative(target, this.projectRoot);
    } catch (error) {
      swallowed('copying the error context', error);
      return toPosixRelative(source, this.projectRoot);
    }
  }

  private finish(result: FullResult): { status?: FullResult['status'] } | undefined {
    const suite = this.suite;
    if (suite === undefined) {
      return undefined;
    }

    // The one pass over allTests(): `outcome()` is the only place `flaky` exists, and it is only
    // meaningful once every attempt has finished.
    const tests: TestRecord[] = [];
    const failedKeys: string[] = [];
    const titleByKey = new Map<string, { title: string; file: string; project: string }>();

    for (const test of suite.allTests()) {
      const file = toPosixRelative(test.location.file, this.projectRoot);
      const project = this.projectOf(test);
      const tail = titlePathAfterFile(test.titlePath(), file);
      const key = testKey(project, file, tail);
      const attempts = this.attempts.get(key) ?? [];
      if (attempts.length === 0) {
        continue;
      }
      const outcome = test.outcome();
      tests.push({
        testKey: key,
        pwId: test.id,
        project,
        file,
        titlePath: tail,
        line: test.location.line,
        tags: test.tags,
        outcome,
        attempts,
        annotations: test.annotations.map(annotation => ({
          type: annotation.type,
          description: annotation.description,
        })),
      });
      if (outcome === 'unexpected') {
        failedKeys.push(key);
        titleByKey.set(key, { title: tail[tail.length - 1] ?? test.title, file, project });
      }
    }

    const record: RunRecord = {
      schema: RUN_SCHEMA,
      runId: this.runId,
      shard: this.config.shard,
      startedAt: new Date(this.started).toISOString(),
      durationMs: Date.now() - this.started,
      ci: envOr('CI') !== undefined,
      commit: envOr('GITHUB_SHA') ?? gitValue(['rev-parse', 'HEAD'], this.projectRoot),
      branch:
        envOr('GITHUB_HEAD_REF') ??
        envOr('GITHUB_REF_NAME') ??
        gitValue(['rev-parse', '--abbrev-ref', 'HEAD'], this.projectRoot),
      baseRef: envOr('GITHUB_BASE_REF'),
      workers: this.config.workers,
      projects: this.config.projects,
      configRetries: this.config.retries,
      status: result.status,
      globalErrors: this.globalErrors,
      tests,
    };

    const runsDir = path.resolve(this.projectRoot, this.options.runsDir ?? RUNS_DIR);
    writeRun(runsDir, record);
    pruneRuns(runsDir, this.options.keep ?? DEFAULT_KEEP);

    if (this.quarantineProblem !== undefined) {
      process.stderr.write(`[heal] ${this.quarantineProblem}\n`);
    }
    if (this.options.shield === false || result.status !== 'failed') {
      return undefined;
    }

    const decision = decideShield(failedKeys, this.quarantine, Date.now());
    const lines: string[] = [];
    for (const entry of decision.used) {
      const days = daysLeft(entry, Date.now());
      const issue = entry.issue === undefined ? ' — NO ISSUE' : ` ${entry.issue}`;
      lines.push(
        `  ✗ ${entry.title}  (${entry.class}, expires in ${days} day${days === 1 ? '' : 's'},${issue})`,
      );
    }
    for (const entry of decision.expired) {
      lines.push(`  ✗ ${entry.title}  (${entry.class}, quarantine EXPIRED — this run stays red)`);
    }
    if (lines.length > 0) {
      // Three different situations, and each deserves its own sentence: everything covered, some
      // covered but the run stays red anyway, and entries that have simply run out.
      const headline = decision.shield
        ? `[heal] ${decision.used.length} quarantined failure(s) did not fail the run:`
        : decision.expired.length > 0 && decision.used.length === 0
          ? `[heal] ${decision.expired.length} quarantine entr${decision.expired.length === 1 ? 'y has' : 'ies have'} expired — this run stays red:`
          : `[heal] ${decision.used.length} failure(s) are quarantined, but ${decision.unshielded.length} other(s) are not, so the run stays red:`;
      process.stdout.write(
        [
          headline,
          ...lines,
          `  Quarantine: ${this.quarantine.length} entr${this.quarantine.length === 1 ? 'y' : 'ies'}. \`npx heal gate\` enforces the budget.`,
          '',
        ].join('\n'),
      );
    }

    return decision.shield ? { status: 'passed' } : undefined;
  }
}

export default HealReporter;
