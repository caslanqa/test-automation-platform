/**
 * Result sync, delegated.
 *
 * `playwright-qase-reporter` already does the whole job — native Playwright attachments (trace.zip,
 * video, screenshots, `error-context.md`) go up because its metadata extractor appends every
 * unrecognised entry of `result.attachments` to the test's attachment list; `test.step()` becomes Qase
 * steps; results publish in batches while the run is still open; retries collapse into a flaky mark.
 * Rewriting that would be copying ~2000 lines of somebody else's correct code, so this file is the one
 * place in the package that names it, and all it contributes is **which options**.
 *
 * The one thing the vendor reporter cannot decide for itself is run ownership under sharding:
 *
 * | `QASE_TESTOPS_RUN_ID` | What this sets | Why |
 * |---|---|---|
 * | set (CI created the run) | `run.id`, `complete: false` | shard 1 completing the run would lock shards 2..N out of it |
 * | unset (a local run) | `run.title` from git, `complete: true` | nobody else is going to close it |
 *
 * @example
 * const reporter = createQaseReporter(readConfig(), readQaseConfig());
 */
import type { Reporter } from '@playwright/test/reporter';
// The `/reporter` subpath, not the package root: the package is CommonJS, so its root `export … as
// default` lands on `exports.default` and a default import gets the namespace object instead of the
// class. The named export here is unambiguous under every module setting.
import {
  PlaywrightQaseReporter,
  type PlaywrightQaseOptionsType,
} from 'playwright-qase-reporter/reporter';

import { runTitle, type TmsConfig } from '../../config.js';
import type { QaseConfig } from './config.js';

/** Qase caps a results batch at 200; 100 keeps a slow upload from stalling a fast suite's tail. */
const BATCH_SIZE = 100;

/**
 * Build the option object the vendor reporter expects.
 *
 * Exported separately from {@link createQaseReporter} so a test can assert the shard branch without
 * constructing a reporter that would try to reach the network.
 */
export function qaseReporterOptions(
  config: TmsConfig,
  qase: QaseConfig,
): PlaywrightQaseOptionsType {
  const hasExternalRun = qase.runId !== '' && Number.isFinite(Number(qase.runId));
  return {
    mode: 'testops',
    debug: false,
    environment: config.environment === '' ? undefined : config.environment,
    testops: {
      api: { token: qase.token, ...(qase.baseUrl === '' ? {} : { host: hostOf(qase.baseUrl) }) },
      project: qase.project,
      uploadAttachments: true,
      batch: { size: BATCH_SIZE },
      run: hasExternalRun
        ? { id: Number(qase.runId), complete: false }
        : { title: runTitle(config), complete: true },
    },
    framework: {
      // The browser is a real dimension of a Playwright result — the same case passing on chromium and
      // failing on webkit is two facts, and without this it is one confusing one.
      browser: { addAsParameter: true, parameterName: 'Browser' },
      markAsFlaky: true,
    },
  } as PlaywrightQaseOptionsType;
}

/**
 * The reporter's `api.host` is a bare host, not the `/v1` URL our own client uses. Deriving it here
 * keeps `QASE_API_BASE_URL` a single knob rather than two that can disagree.
 */
function hostOf(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).host;
  } catch {
    return undefined;
  }
}

export function createQaseReporter(config: TmsConfig, qase: QaseConfig): Reporter {
  return new PlaywrightQaseReporter(qaseReporterOptions(config, qase));
}
