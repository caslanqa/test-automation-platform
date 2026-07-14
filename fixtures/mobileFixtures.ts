import fs from 'fs';
import path from 'path';

import { test as base, expect } from '@playwright/test';

import { loadEnv } from '@config/loadEnv';
import { ensureAppInstalled } from '@mobile/core/appInstaller';
import { acquireDeviceLock, deviceLockKey } from '@mobile/core/deviceLock';
import { DeviceManager } from '@mobile/core/DeviceManager';
import { maestroFailureDetail, parseMaestroSteps } from '@mobile/core/maestroReport';
import { MaestroRunner, maestroSupportsParallel } from '@mobile/core/MaestroRunner';
import type { DiscoveredDevice, MobilePlatform } from '@mobile/core/types';

// Load the selected environment (MOBILE_PLATFORM → process.env) before any test runs.
loadEnv();

/** Options this test object adds. */
export interface MobileOptions {
  /**
   * Mobile run selection. Set per file/describe with
   * `test.use({ mobile: { platform: 'android', device: 'Pixel_7_API_34' } })`.
   * - `platform` falls back to the `MOBILE_PLATFORM` env var.
   * - `device` (Android AVD name, or iOS simulator name/UDID) falls back to `MOBILE_DEVICE`; when
   *   set, the device is booted automatically if it isn't running. When omitted, an already-booted
   *   device is used (otherwise the test skips).
   * - `headless` hides the device (`-no-window` on Android, no Simulator GUI on iOS); set `false` to
   *   show the emulator window / Simulator app. Precedence: this per-test value, then the central
   *   `MOBILE_HEADLESS` default (env / env/environments.json), then `true`. It's scoped to this
   *   `test.use()` block, and always takes effect — a reused device is switched to the requested mode.
   * - `app` (local path or http(s) URL to an APK / iOS `.app`/`.zip`) is installed on the device once
   *   before the flow runs; the flow then `launchApp`s it by `appId`. Falls back to `MOBILE_APP_ANDROID`
   *   / `MOBILE_APP_IOS` (env). Omit for built-in apps (e.g. the Settings example) that need no install.
   *
   * For **parallel** runs, give each test its device and pass `--workers=N`: tests on the same device
   * serialize (a cross-process lock — they wait, not skip), different devices run in parallel. See
   * "Running in parallel" in docs/MOBILE_TESTING.md.
   */
  mobile:
    { platform?: MobilePlatform; device?: string; headless?: boolean; app?: string } | undefined;
}

/** The runtime facade a mobile test uses. */
export interface MaestroFixture {
  /** The booted device this test is running against. */
  device: DiscoveredDevice;
  /** Run a Maestro flow (project-relative path) and attach its artifacts to the report. */
  run(flowPath: string, options?: { tags?: string[] }): Promise<void>;
}

interface MobileFixtures {
  maestro: MaestroFixture;
}

/** Resolve the active platform from the `mobile` option or `MOBILE_PLATFORM` env; throw if neither. */
function resolvePlatform(option: MobileOptions['mobile']): MobilePlatform {
  const platform = option?.platform ?? process.env.MOBILE_PLATFORM;
  if (platform !== 'android' && platform !== 'ios') {
    throw new Error(
      "[mobile] platform not set — use test.use({ mobile: { platform: 'android' | 'ios' } }) " +
        'or set MOBILE_PLATFORM in env/environments.json'
    );
  }
  return platform;
}

/**
 * Resolve headless: an explicit per-test `headless` wins; otherwise the central `MOBILE_HEADLESS`
 * default (env / env/environments.json); otherwise `true` (hidden).
 */
function resolveHeadless(option?: boolean): boolean {
  if (typeof option === 'boolean') {
    return option;
  }
  const env = process.env.MOBILE_HEADLESS?.trim();
  return env ? /^(1|true|yes|on)$/i.test(env) : true;
}

/**
 * A failure whose report shows just the message (the Maestro step + reason) — not this fixture's
 * internal throw-site. We overwrite `stack` so Playwright renders no code snippet pointing at our
 * `throw`, which is meaningless noise for a mobile test author.
 */
function maestroError(message: string): Error {
  const error = new Error(message);
  error.stack = message;
  return error;
}

/** Recursively collect the PNG screenshots Maestro wrote under `dir`. */
function screenshots(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { recursive: true })
    .map(entry => path.join(dir, String(entry)))
    .filter(file => file.toLowerCase().endsWith('.png'));
}

/**
 * Mobile test object. Adds a `mobile` selection option and a `maestro` fixture that runs Maestro
 * flows against a booted device and bridges Maestro artifacts into the Playwright report. Extends
 * the plain Playwright base (mobile needs no browser). When no device is booted for the platform,
 * the test is SKIPPED (not failed). Import directly:
 * `import { test, expect } from '@fixtures/mobileFixtures'`.
 */
export const test = base.extend<MobileOptions & MobileFixtures>({
  mobile: [undefined, { option: true }],

  // `box: true` hides this fixture from the report's Before/After Hooks — the mobile test shows just
  // its Maestro flow steps (below), not a `fixture: maestro` section, matching Maestro's clean HTML.
  maestro: [
    async ({ mobile }, use, testInfo) => {
      const platform = resolvePlatform(mobile);
      const deviceName = mobile?.device || process.env.MOBILE_DEVICE || undefined;

      // Reserve the device across workers so parallel runs (`--workers=N`) don't double-book it: same
      // device → serialize (wait), different devices → parallel. Modern Maestro (>= ~2.6) runs concurrent
      // flows on different devices safely; on older Maestro (fixed driver port → clash/hang) we fall back
      // to ONE shared lock so `--workers>1` stays safe (just not faster). Override with MOBILE_PARALLEL.
      const lockKey = maestroSupportsParallel() ? deviceLockKey(platform, deviceName) : 'maestro';
      const release = await acquireDeviceLock(lockKey);
      try {
        const device = await new DeviceManager().acquire(
          platform,
          deviceName,
          resolveHeadless(mobile?.headless)
        );
        if (!device) {
          testInfo.skip(
            true,
            `[mobile] no ${platform} device available — name one via the mobile option to auto-boot it, ` +
              'create one with `npm run mobile:create-device`, or boot a device manually. See docs/MOBILE_TESTING.md'
          );
          return;
        }

        // Install the app under test (if configured) once before the flow runs; built-in apps need none.
        const appSource =
          mobile?.app ??
          (platform === 'android' ? process.env.MOBILE_APP_ANDROID : process.env.MOBILE_APP_IOS);
        if (appSource) {
          await ensureAppInstalled(device, appSource);
        }

        const runner = new MaestroRunner();
        await use({
          device,
          run: async (flowPath, options) => {
            const result = await runner.run(flowPath, {
              device: device.id,
              platform: device.platform,
              outputDir: testInfo.outputDir,
              tags: options?.tags,
            });

            // Bridge Maestro artifacts into the report (attached even on failure). We push directly to
            // `testInfo.attachments` instead of `testInfo.attach()` on purpose: `attach()` renders an
            // "Attach …" entry in the step list, which would clutter the flow. Pushing registers the
            // artifact (still shown under Attachments) without a step, so the step list stays clean —
            // just the Maestro flow steps below. Files live in outputDir, which the reporter copies.
            if (fs.existsSync(result.junitPath)) {
              testInfo.attachments.push({
                name: 'maestro-junit',
                path: result.junitPath,
                contentType: 'application/xml',
              });
            }
            for (const png of screenshots(result.outputDir)) {
              testInfo.attachments.push({
                name: path.basename(png),
                path: png,
                contentType: 'image/png',
              });
            }
            const logPath = path.join(result.outputDir, 'debug', 'maestro.log');
            if (fs.existsSync(logPath)) {
              testInfo.attachments.push({
                name: 'maestro-log',
                path: logPath,
                contentType: 'text/plain',
              });
            }

            // Replay Maestro's commands as native Playwright steps so the HTML report / trace shows the
            // flow step-by-step and marks exactly which step failed — with the real reason (Maestro logs
            // the cause to maestro.log, not stderr). Fall back to the exit-code error if unparsable.
            const detail =
              maestroFailureDetail(result.outputDir) ||
              result.stderr.trim().split('\n').slice(-20).join('\n');
            for (const step of parseMaestroSteps(result.outputDir)) {
              const title = step.durationMs ? `${step.label} (${step.durationMs}ms)` : step.label;
              // Replay each Maestro command as a native step — the report shows just its name + duration,
              // and if it failed, the reason. We deliberately DON'T pass `{ box: true }`: box would
              // re-attribute the failure to the step's call site and print a code frame; maestroError
              // (stack = message only) keeps the failing step showing just the reason, no code frame.
              await base.step(title, () => {
                if (step.status !== 'COMPLETED' && step.status !== 'WARNED') {
                  throw maestroError(`[maestro] step "${step.label}" ${step.status}\n${detail}`);
                }
              });
            }
            if (result.exitCode !== 0) {
              throw maestroError(
                `[maestro] ${flowPath} failed (exit ${result.exitCode})\n${detail}`
              );
            }
          },
        });
      } finally {
        release();
      }
    },
    { box: true },
  ],
});

export { expect };
