import fs from 'node:fs';
import path from 'node:path';

import { test as base, expect } from '@playwright/test';

import type { DiscoveredDevice, MobilePlatform, ScreenRecording } from '@pwtap/platform';
import {
  acquireDevice,
  acquireDeviceLock,
  clearLogcat,
  deviceLockKey,
  dumpLogcat,
  dumpSimLog,
  logCaptureStart,
  startAndroidRecording,
  startSimRecording,
} from '@pwtap/platform';

import { ensureAppInstalled } from './core/appInstaller.js';
import { recordBootedDevice } from './core/booted.js';
import { maestroError } from './core/maestroError.js';
import type { MaestroDirection, ScreenshotMode } from './core/MaestroMcpSession.js';
import { MaestroMcpSession, resolveVerboseStepLogs } from './core/MaestroMcpSession.js';
import { maestroFailureDetail, parseMaestroSteps } from './core/maestroReport.js';
import { MaestroRunner, maestroSupportsParallel } from './core/MaestroRunner.js';
import type { MaestroScreen, MaestroSelector } from './core/types.js';

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
   *   show it. Precedence: this per-test value, then `MOBILE_HEADLESS` (env), then `true`.
   * - `app` (local path or http(s) URL to an APK / iOS `.app`/`.zip`) is installed on the device once
   *   before the flow runs. Falls back to `MOBILE_APP_ANDROID` / `MOBILE_APP_IOS`. Omit for built-in
   *   apps (e.g. the Settings example) that need no install.
   *
   * Screen recording and screenshots are NOT separate mobile settings — this fixture reads
   * Playwright's own built-in `video`/`screenshot` options (`use.video`/`use.screenshot` in
   * playwright.config.ts, or a project/describe override), so one central setting governs both for
   * chromium AND maestro alike. All seven of Playwright's video modes are honored
   * (`off`/`on`/`retain-on-failure`/`on-first-retry`/`on-all-retries`/`retain-on-first-failure`/
   * `retain-on-failure-and-retries`), and all four screenshot modes
   * (`off`/`on`/`only-on-failure`/`on-first-failure`).
   *
   * For **parallel** runs, give each test its device and pass `--workers=N`: tests on the same device
   * serialize (a cross-process lock — they wait, not skip), different devices run in parallel.
   */
  mobile:
    { platform?: MobilePlatform; device?: string; headless?: boolean; app?: string } | undefined;
}

/**
 * The runtime facade a mobile test uses. Two authoring styles, mixable in one test:
 *
 * - **Imperative** (Playwright-style): `await maestro.launchApp(id); await maestro.tapOn('Login')`.
 *   Each call runs one Maestro command against a warm device driver and appears as a report step;
 *   `isVisible` / `inspectScreen` let you branch in TypeScript on the live screen.
 * - **Batch YAML**: `await maestro.run('tests/maestro/flows/login.yaml')` runs an authored flow file.
 */
export interface MaestroFixture {
  /** The booted device this test is running against. */
  device: DiscoveredDevice;
  /** Run an authored Maestro flow (project-relative path) and attach its artifacts to the report. */
  run(flowPath: string, options?: { tags?: string[] }): Promise<void>;

  /** Launch the app under test; call before element commands (they need the app id). */
  launchApp(appId: string, options?: { clearState?: boolean; stopApp?: boolean }): Promise<void>;
  /** Tap an element. */
  tapOn(selector: MaestroSelector): Promise<void>;
  /** Double-tap an element. */
  doubleTapOn(selector: MaestroSelector): Promise<void>;
  /** Long-press an element. */
  longPressOn(selector: MaestroSelector): Promise<void>;
  /** Type text into the focused field. */
  inputText(text: string): Promise<void>;
  /** Erase characters from the focused field (all, or the last `charactersToErase`). */
  eraseText(charactersToErase?: number): Promise<void>;
  /** Assert an element is visible. */
  assertVisible(selector: MaestroSelector): Promise<void>;
  /** Assert an element is not visible. */
  assertNotVisible(selector: MaestroSelector): Promise<void>;
  /** Whether an element is visible within `timeout` ms (default 2000) — for branching, never fails. */
  isVisible(selector: MaestroSelector, options?: { timeout?: number }): Promise<boolean>;
  /** Press the system Back button. */
  back(): Promise<void>;
  /** Press a hardware/system key (e.g. `Enter`, `Home`, `Back`). */
  pressKey(key: string): Promise<void>;
  /** Hide the on-screen keyboard. */
  hideKeyboard(): Promise<void>;
  /** Scroll down one screen. */
  scroll(): Promise<void>;
  /** Scroll (default down) until an element is visible. */
  scrollUntilVisible(
    selector: MaestroSelector,
    options?: { direction?: MaestroDirection },
  ): Promise<void>;
  /** Swipe by direction, or between two `x%,y%` points. */
  swipe(options: {
    direction?: MaestroDirection;
    start?: string;
    end?: string;
    duration?: number;
  }): Promise<void>;
  /** Wait for on-screen animations to settle. */
  waitForAnimationToEnd(): Promise<void>;
  /**
   * Capture the current screen, attach it to the report as `<name>`, and return the file path — pipe
   * it into the AI judge: `expect({ image: await maestro.takeScreenshot('home'), rubric })`.
   */
  takeScreenshot(name: string): Promise<string>;
  /** The current screen's view hierarchy (Maestro's `inspect_screen`) — for TypeScript branching. */
  inspectScreen(): Promise<MaestroScreen>;
  /** The value in the row labelled `label` (e.g. `rowValue('Name')` → `'iPhone'`), or `undefined`. */
  rowValue(label: string): Promise<string | undefined>;
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
        'or set MOBILE_PLATFORM in env/environments.json',
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

/** Attach the device's real system log for the whole test — from `MOBILE_DEVICE_LOG`. */
function resolveDeviceLogMode(): boolean {
  const value = process.env.MOBILE_DEVICE_LOG?.trim();
  return value ? /^(1|true|yes|on)$/i.test(value) : false;
}

/** Playwright's own `video` modes (its `VideoMode` type) — the values `use.video` resolves to. */
type PlaywrightVideoMode =
  | 'off'
  | 'on'
  | 'retain-on-failure'
  | 'on-first-retry'
  | 'on-all-retries'
  | 'retain-on-first-failure'
  | 'retain-on-failure-and-retries';

/** Normalize the injected `video` fixture value — a bare mode string, or `{ mode, size, show }`. */
function videoModeOf(video: unknown): PlaywrightVideoMode {
  if (typeof video === 'string') {
    return video as PlaywrightVideoMode;
  }
  if (video && typeof video === 'object' && 'mode' in video) {
    return (video as { mode: PlaywrightVideoMode }).mode;
  }
  return 'off';
}

/**
 * Whether to even start recording THIS attempt, given Playwright's `video` mode and the attempt
 * number (`testInfo.retry`: `0` on the first attempt, `1` on the first retry, …). Modes scoped to
 * retries only start recording once we're actually on a qualifying attempt, so a first attempt under
 * `on-first-retry` never pays the recording cost for a video that would just be discarded anyway.
 */
function shouldStartRecording(mode: PlaywrightVideoMode, retry: number): boolean {
  switch (mode) {
    case 'off':
      return false;
    case 'retain-on-first-failure':
      return retry === 0;
    case 'on-first-retry':
      return retry === 1;
    case 'on-all-retries':
      return retry >= 1;
    default: // 'on' | 'retain-on-failure' | 'retain-on-failure-and-retries'
      return true;
  }
}

/** Whether to keep (attach) a recording that WAS started, given the mode, attempt, and outcome. */
function shouldKeepRecording(mode: PlaywrightVideoMode, retry: number, failed: boolean): boolean {
  switch (mode) {
    case 'off':
      return false;
    case 'on':
    case 'on-first-retry':
    case 'on-all-retries':
      return true; // these modes only ever record on a qualifying attempt — keep whenever recorded
    case 'retain-on-failure':
    case 'retain-on-first-failure':
      return failed;
    case 'retain-on-failure-and-retries':
      return failed || retry >= 1;
  }
}

/** Playwright's own `screenshot` modes (its type) — the values `use.screenshot` resolves to. */
type PlaywrightScreenshotMode = 'off' | 'on' | 'only-on-failure' | 'on-first-failure';

/** Normalize the injected `screenshot` fixture value — a bare mode string, or `{ mode, ... }`. */
function screenshotModeOf(screenshot: unknown): PlaywrightScreenshotMode {
  if (typeof screenshot === 'string') {
    return screenshot as PlaywrightScreenshotMode;
  }
  if (screenshot && typeof screenshot === 'object' && 'mode' in screenshot) {
    return (screenshot as { mode: PlaywrightScreenshotMode }).mode;
  }
  return 'off';
}

/**
 * Collapse Playwright's `screenshot` mode down to {@link ScreenshotMode} (the 3 values
 * `MaestroMcpSession` understands): `on-first-failure` only applies on the first attempt
 * (`testInfo.retry === 0`) — on any retry it behaves as `off`, since a failure screenshot from the
 * first attempt was already captured and retries wouldn't add one under this mode.
 */
function toSessionScreenshotMode(mode: PlaywrightScreenshotMode, retry: number): ScreenshotMode {
  if (mode === 'on-first-failure') {
    return retry === 0 ? 'only-on-failure' : 'off';
  }
  return mode;
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
 * flows (YAML) and imperative commands against a booted device, bridging Maestro artifacts into the
 * Playwright report. Extends the plain Playwright base (mobile needs no browser). When no device is
 * booted for the platform, the test is SKIPPED (not failed). Composed into the `@fixtures` barrel by
 * `create-pwtap add maestro` (as `maestroTest`); also importable directly.
 */
export const test = base.extend<MobileOptions & MobileFixtures>({
  mobile: [undefined, { option: true }],

  // `box: true` hides this fixture from the report's Before/After Hooks — the mobile test shows just
  // its Maestro flow steps, not a `fixture: maestro` section.
  maestro: [
    async ({ mobile, video, screenshot }, use, testInfo) => {
      const platform = resolvePlatform(mobile);
      const deviceName = mobile?.device || process.env.MOBILE_DEVICE || undefined;

      // Reserve the device across workers so parallel runs don't double-book it: same device →
      // serialize (wait), different devices → parallel. Modern Maestro (>= ~2.6) runs concurrent
      // flows on different devices safely; on older Maestro we fall back to ONE shared lock so
      // `--workers>1` stays safe (just not faster). Override with MOBILE_PARALLEL.
      const lockKey = maestroSupportsParallel() ? deviceLockKey(platform, deviceName) : 'maestro';
      const release = await acquireDeviceLock(lockKey);
      // Declared out here (not inside try) so `finally` can reach them even if `use` throws mid-test.
      let session: MaestroMcpSession | undefined;
      let recording: ScreenRecording | undefined;
      let videoPath: string | undefined;
      let deviceLogEnabled = false;
      let videoMode: PlaywrightVideoMode = 'off';
      let iosLogStart: string | undefined;
      let device: DiscoveredDevice | null = null;
      try {
        device = await acquireDevice(platform, {
          deviceName,
          headless: resolveHeadless(mobile?.headless),
          onBooted: recordBootedDevice, // record framework-booted devices so globalTeardown stops them
        });
        if (!device) {
          testInfo.skip(
            true,
            `[mobile] no ${platform} device available — name one via the mobile option to auto-boot it, ` +
              'create one with `npm run mobile:create-device`, or boot a device manually. See docs/MOBILE_TESTING.md',
          );
          return;
        }

        // Start whole-test evidence capture (device log window / screen recording) as early as
        // possible, so it also covers app install below. Both are best-effort and gated off by
        // default — neither adds overhead unless explicitly enabled.
        deviceLogEnabled = resolveDeviceLogMode();
        if (deviceLogEnabled) {
          if (platform === 'android') {
            await clearLogcat(device.id);
          } else {
            iosLogStart = logCaptureStart();
          }
        }
        videoMode = videoModeOf(video);
        if (shouldStartRecording(videoMode, testInfo.retry)) {
          videoPath = testInfo.outputPath('maestro-recording.mp4');
          recording =
            platform === 'android'
              ? startAndroidRecording(device.id, videoPath)
              : startSimRecording(device.id, videoPath);
        }

        // Install the app under test (if configured) once before the flow runs; built-in apps need none.
        const appSource =
          mobile?.app ??
          (platform === 'android' ? process.env.MOBILE_APP_ANDROID : process.env.MOBILE_APP_IOS);
        if (appSource) {
          await ensureAppInstalled(device, appSource);
        }

        // A stable non-null binding for the closures below — TS doesn't carry the `if (!device)`
        // narrowing of the outer `let` into nested arrow functions (e.g. `run` below).
        const readyDevice = device;
        const runner = new MaestroRunner();
        // Screenshot capture is likewise driven by Playwright's own `screenshot` option (not a
        // mobile-specific setting) — same reasoning as `video` above.
        const screenshotMode = toSessionScreenshotMode(
          screenshotModeOf(screenshot),
          testInfo.retry,
        );
        // The imperative API's warm-driver session. Created here but only spawns its `maestro mcp`
        // process on the first imperative call, so batch-only tests (`maestro.run(flow)`) never pay
        // for it. Each command is reported as a step; artifacts attach without adding steps.
        const mcp = new MaestroMcpSession(
          readyDevice,
          {
            step: (title, body) => base.step(title, body),
            outputDir: testInfo.outputDir,
            // `testInfo.attach` (not attachments.push) so a screenshot/hierarchy binds to the current
            // step — the failure evidence shows under the failing step, in the report and the trace.
            report: (name, attachment) => testInfo.attach(name, attachment),
          },
          { screenshotMode },
        );
        session = mcp; // hand to `finally` for teardown; `mcp` is what the closures below capture
        await use({
          device,
          launchApp: (appId, options) => mcp.launchApp(appId, options),
          tapOn: selector => mcp.tapOn(selector),
          doubleTapOn: selector => mcp.doubleTapOn(selector),
          longPressOn: selector => mcp.longPressOn(selector),
          inputText: text => mcp.inputText(text),
          eraseText: charactersToErase => mcp.eraseText(charactersToErase),
          assertVisible: selector => mcp.assertVisible(selector),
          assertNotVisible: selector => mcp.assertNotVisible(selector),
          isVisible: (selector, options) => mcp.isVisible(selector, options),
          back: () => mcp.back(),
          pressKey: key => mcp.pressKey(key),
          hideKeyboard: () => mcp.hideKeyboard(),
          scroll: () => mcp.scroll(),
          scrollUntilVisible: (selector, options) => mcp.scrollUntilVisible(selector, options),
          swipe: options => mcp.swipe(options),
          waitForAnimationToEnd: () => mcp.waitForAnimationToEnd(),
          takeScreenshot: name => mcp.takeScreenshot(name),
          inspectScreen: () => mcp.inspectScreen(),
          rowValue: label => mcp.rowValue(label),
          run: async (flowPath, options) => {
            const result = await runner.run(flowPath, {
              device: readyDevice.id,
              platform: readyDevice.platform,
              outputDir: testInfo.outputDir,
              tags: options?.tags,
            });

            // Bridge Maestro artifacts into the report (attached even on failure). We push directly to
            // `testInfo.attachments` instead of `testInfo.attach()` on purpose: `attach()` renders an
            // "Attach …" entry in the step list, which would clutter the flow. Pushing registers the
            // artifact (still under Attachments) without a step, so the step list stays clean.
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
            const verboseStepLogs = resolveVerboseStepLogs();
            for (const step of parseMaestroSteps(result.outputDir)) {
              const title = step.durationMs ? `${step.label} (${step.durationMs}ms)` : step.label;
              // Replay each Maestro command as a native step. We deliberately DON'T pass `{ box: true }`:
              // box would re-attribute the failure to the step's call site and print a code frame;
              // maestroError (stack = message only) keeps the failing step showing just the reason.
              await base.step(title, async () => {
                const failed = step.status !== 'COMPLETED' && step.status !== 'WARNED';
                // The step's real log: Maestro's exact recorded command + metadata for this step —
                // not just the label/status we synthesize. Always on failure, opt-in on success.
                if (failed || verboseStepLogs) {
                  try {
                    await testInfo.attach('maestro-step-log', {
                      body: JSON.stringify(step.raw, null, 2),
                      contentType: 'application/json',
                    });
                  } catch {
                    /* best-effort — never let log attachment mask the real result */
                  }
                }
                if (failed) {
                  throw maestroError(`[maestro] step "${step.label}" ${step.status}\n${detail}`);
                }
              });
            }
            if (result.exitCode !== 0) {
              throw maestroError(
                `[maestro] ${flowPath} failed (exit ${result.exitCode})\n${detail}`,
              );
            }
          },
        });
      } finally {
        // Tear down the warm `maestro mcp` process (no-op if it never spawned) BEFORE releasing the
        // device lock, so the next test on this device starts with a clean driver — two mcp processes
        // on one device would kill the driver.
        await session?.close();

        if (recording && videoPath) {
          const produced = await recording.stop();
          const failed = testInfo.status !== testInfo.expectedStatus;
          if (produced && shouldKeepRecording(videoMode, testInfo.retry, failed)) {
            testInfo.attachments.push({
              name: 'maestro-recording',
              path: videoPath,
              contentType: 'video/mp4',
            });
          }
        }

        if (deviceLogEnabled && device) {
          try {
            const log =
              platform === 'android'
                ? await dumpLogcat(device.id)
                : await dumpSimLog(device.id, iosLogStart ?? logCaptureStart());
            const logPath = testInfo.outputPath('device.log');
            fs.writeFileSync(logPath, log);
            testInfo.attachments.push({
              name: 'device-log',
              path: logPath,
              contentType: 'text/plain',
            });
          } catch {
            /* best-effort — device log capture never masks the real test result */
          }
        }

        release();
      }
    },
    { box: true },
  ],
});

export { expect };
