/**
 * The entry the client's `playwright.config.ts` points at — a switch and a forwarder, nothing else.
 *
 * Two jobs:
 *
 * 1. **Stay off by default.** `TMS_MODE` is not `testops` → no provider is resolved, no vendor reporter
 *    is constructed, every hook returns immediately, and the run makes no network call. That is the same
 *    contract every other plugin's env-gated project honours, and it is what lets this reporter sit in
 *    the config of a project that has not configured a test management tool yet.
 * 2. **Point at a provider, not a package.** The vendor reporter is constructed by
 *    `providers/qase/reporter.ts`; this file never names it. Swapping `TMS_PROVIDER` swaps the
 *    delegate without touching the client's config.
 *
 * **Not fail-open**, unlike `@pwtap/plugin-heal`'s reporter. That one is advisory, so swallowing its own
 * errors is right. This one was explicitly asked to publish results: an upload that fails silently
 * leaves a green CI job next to an empty Qase run, and nobody finds out until someone needs the
 * evidence. Errors surface. Misconfiguration surfaces at construction, before a single test runs.
 *
 * @example
 * // playwright.config.ts
 * reporter: [['list'], ['@pwtap/plugin-tms/reporter', {}]]
 */
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

import { readConfig } from './config.js';
import { resolveProvider } from './providers/index.js';

export default class TmsReporter implements Reporter {
  private readonly delegate: Reporter | null;

  constructor() {
    const config = readConfig();
    this.delegate = config.mode === 'testops' ? resolveProvider(config).createReporter() : null;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.delegate?.onBegin?.(config, suite);
  }

  onTestBegin(test: TestCase, result: TestResult): void {
    this.delegate?.onTestBegin?.(test, result);
  }

  onStepBegin(test: TestCase, result: TestResult, step: TestStep): void {
    this.delegate?.onStepBegin?.(test, result, step);
  }

  onStepEnd(test: TestCase, result: TestResult, step: TestStep): void {
    this.delegate?.onStepEnd?.(test, result, step);
  }

  onTestEnd(test: TestCase, result: TestResult): void | Promise<void> {
    return this.delegate?.onTestEnd?.(test, result);
  }

  onStdOut(chunk: string | Buffer, test?: TestCase, result?: TestResult): void {
    this.delegate?.onStdOut?.(chunk, test, result);
  }

  onStdErr(chunk: string | Buffer, test?: TestCase, result?: TestResult): void {
    this.delegate?.onStdErr?.(chunk, test, result);
  }

  onError(error: TestError): void {
    this.delegate?.onError?.(error);
  }

  /** Playwright lets `onEnd` return a status override, so the signature is borrowed rather than narrowed. */
  onEnd(result: FullResult): ReturnType<NonNullable<Reporter['onEnd']>> {
    return this.delegate?.onEnd?.(result);
  }

  async onExit(): Promise<void> {
    await this.delegate?.onExit?.();
  }

  /**
   * Mirrors the delegate. Playwright's default for an unimplemented `printsToStdio` is `true`, so an
   * inert wrapper claiming the terminal would suppress the default `list` output in a config that has
   * none of its own.
   */
  printsToStdio(): boolean {
    return this.delegate === null ? false : (this.delegate.printsToStdio?.() ?? true);
  }
}
