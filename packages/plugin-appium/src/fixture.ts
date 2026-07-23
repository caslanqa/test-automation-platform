import fs from 'node:fs';

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
  recordBootedDevice,
  startAndroidRecording,
  startSimRecording,
} from '@pwtap/platform';

import { resolveAppArtifact } from './core/appArtifact.js';
import { assertPlatformSupported, ensureAppiumServer } from './core/appiumServer.js';
import { buildCapabilities } from './core/caps.js';
import { closeSession, createSession } from './core/session.js';

/** Options this test object adds. */
export interface AppiumOptions {
  /**
   * Appium run selection. Set per file/describe with
   * `test.use({ appium: { platform: 'android', device: 'Pixel_7_API_34' } })`.
   * - `platform` falls back to the `APPIUM_PLATFORM` env var.
   * - `device` (Android AVD name, or iOS simulator name/UDID) falls back to `APPIUM_DEVICE`; when
   *   set, the device is booted automatically if it isn't running. When omitted, an already-booted
   *   device is used (otherwise the test skips).
   * - `headless` hides the device (`-no-window` on Android, no Simulator GUI on iOS); set `false` to
   *   show it. Precedence: this per-test value, then `APPIUM_HEADLESS` (env), then `true`.
   * - `app` (local path or http(s) URL to an APK / iOS `.app`/`.zip`) is installed on the device by
   *   the Appium driver during session creation (the `appium:app` capability). Falls back to
   *   `APPIUM_APP_ANDROID` / `APPIUM_APP_IOS`. Omit for built-in apps (e.g. the Settings example).
   * - `capabilities` is an escape hatch for anything not covered above — merged on top of the
   *   computed W3C capabilities (these win).
   *
   * Screen recording and screenshots are NOT separate mobile settings — this fixture reads
   * Playwright's own built-in `video`/`screenshot` options (`use.video`/`use.screenshot` in
   * playwright.config.ts, or a project/describe override), so one central setting governs both for
   * chromium AND appium alike. All seven of Playwright's video modes are honored, and all four
   * screenshot modes — the latter captured once at test end (Appium has no per-command concept).
   *
   * For **parallel** runs, give each test its device and pass `--workers=N`: tests on the same device
   * serialize (a cross-process lock — they wait, not skip), different devices run in parallel.
   */
  appium:
    | {
        platform?: MobilePlatform;
        device?: string;
        headless?: boolean;
        app?: string;
        capabilities?: Record<string, unknown>;
      }
    | undefined;
}

/** A selector accepted by WebdriverIO's `$` command (string, function selector, …). */
type AppiumSelector = Parameters<WebdriverIO.Browser['$']>[0];

/**
 * The full WebdriverIO session, callable directly as a selector shorthand: `app('~Login').click()`
 * is `app.$('~Login').click()`. Every other driver method/property (`$$`, `execute`, `saveScreenshot`,
 * …) is still available on `app` itself — this is the same session, not a wrapper with a reduced API.
 */
export type AppiumApp = WebdriverIO.Browser &
  ((selector: AppiumSelector) => ReturnType<WebdriverIO.Browser['$']>);

/** Wrap `session` so it's callable as a selector shorthand while remaining the full driver object. */
function toCallableApp(session: WebdriverIO.Browser): AppiumApp {
  const call = (selector: AppiumSelector) => session.$(selector);
  return new Proxy(call, {
    get: (target, prop, receiver) =>
      prop in target ? Reflect.get(target, prop, receiver) : Reflect.get(session, prop, session),
    set: (_target, prop, value) => Reflect.set(session, prop, value, session),
    has: (target, prop) => prop in target || prop in session,
  }) as AppiumApp;
}

interface AppiumFixtures {
  /** The booted device this test is running against. */
  device: DiscoveredDevice;
  /** The WebdriverIO session — callable as a selector shorthand (`app('~Login').click()`), and the
   * full driver API otherwise (`app.$$(...)`, `app.execute(...)`, …). */
  app: AppiumApp;
}

/** Resolve the active platform from the `appium` option or `APPIUM_PLATFORM` env; throw if neither. */
function resolvePlatform(option: AppiumOptions['appium']): MobilePlatform {
  const platform = option?.platform ?? process.env.APPIUM_PLATFORM;
  if (platform !== 'android' && platform !== 'ios') {
    throw new Error(
      "[appium] platform not set — use test.use({ appium: { platform: 'android' | 'ios' } }) " +
        'or set APPIUM_PLATFORM in env/environments.json',
    );
  }
  return platform;
}

/**
 * Resolve headless: an explicit per-test `headless` wins; otherwise the central `APPIUM_HEADLESS`
 * default (env / env/environments.json); otherwise `true` (hidden).
 */
function resolveHeadless(option?: boolean): boolean {
  if (typeof option === 'boolean') {
    return option;
  }
  const env = process.env.APPIUM_HEADLESS?.trim();
  return env ? /^(1|true|yes|on)$/i.test(env) : true;
}

/** Attach the device's real system log for the whole test — from `APPIUM_DEVICE_LOG`. */
function resolveDeviceLogMode(): boolean {
  const value = process.env.APPIUM_DEVICE_LOG?.trim();
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
 * number (`testInfo.retry`: `0` on the first attempt, `1` on the first retry, …).
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
      return true;
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
 * Whether to capture a screenshot at test end, given the mode, attempt, and outcome. Appium has no
 * per-command concept like Maestro's step screenshots — `on` means "capture once when the test ends".
 */
function shouldTakeScreenshot(
  mode: PlaywrightScreenshotMode,
  retry: number,
  failed: boolean,
): boolean {
  switch (mode) {
    case 'off':
      return false;
    case 'on':
      return true;
    case 'only-on-failure':
      return failed;
    case 'on-first-failure':
      return failed && retry === 0;
  }
}

/**
 * Appium test object. Adds an `appium` selection option and `device`/`app` fixtures — `app` is the
 * raw WebdriverIO session (`await app.$('~Login').click()`), no curated facade on top. Extends the
 * plain Playwright base (appium needs no browser). When no device is booted for the platform, the
 * test is SKIPPED (not failed). Composed into the `@fixtures` barrel by `create-pwtap add appium`
 * (as `appiumTest`); also importable directly.
 */
export const test = base.extend<AppiumOptions & AppiumFixtures>({
  appium: [undefined, { option: true }],

  // `box: true` hides this fixture from the report's Before/After Hooks.
  device: [
    async ({ appium }, use, testInfo) => {
      const platform = resolvePlatform(appium);
      assertPlatformSupported(platform);
      const deviceName = appium?.device || process.env.APPIUM_DEVICE || undefined;

      // Reserve the device across workers so parallel runs don't double-book it: same device →
      // serialize (wait), different devices → parallel.
      const release = await acquireDeviceLock(deviceLockKey(platform, deviceName));
      let acquired: DiscoveredDevice | null = null;
      try {
        acquired = await acquireDevice(platform, {
          deviceName,
          headless: resolveHeadless(appium?.headless),
          onBooted: recordBootedDevice, // record framework-booted devices so a teardown stops them
        });
        if (!acquired) {
          testInfo.skip(
            true,
            `[appium] no ${platform} device available — name one via the appium option to auto-boot ` +
              'it, create one with Android Studio / Xcode, or boot a device manually. See docs/APPIUM_TESTING.md',
          );
          return;
        }
        await use(acquired);
      } finally {
        release();
      }
    },
    { box: true },
  ],

  app: [
    async ({ appium, device, video, screenshot }, use, testInfo) => {
      let session: WebdriverIO.Browser | undefined;
      let recording: ScreenRecording | undefined;
      let videoPath: string | undefined;
      let deviceLogEnabled = false;
      let videoMode: PlaywrightVideoMode = 'off';
      let iosLogStart: string | undefined;
      try {
        // Start whole-test evidence capture (device log window / screen recording) as early as
        // possible, so it also covers session/app-install below. Both are best-effort and gated off
        // by default.
        deviceLogEnabled = resolveDeviceLogMode();
        if (deviceLogEnabled) {
          if (device.platform === 'android') {
            await clearLogcat(device.id);
          } else {
            iosLogStart = logCaptureStart();
          }
        }
        videoMode = videoModeOf(video);
        if (shouldStartRecording(videoMode, testInfo.retry)) {
          videoPath = testInfo.outputPath('appium-recording.mp4');
          recording =
            device.platform === 'android'
              ? startAndroidRecording(device.id, videoPath)
              : startSimRecording(device.id, videoPath);
        }

        const appSource =
          appium?.app ??
          (device.platform === 'android'
            ? process.env.APPIUM_APP_ANDROID
            : process.env.APPIUM_APP_IOS);
        const app = appSource ? await resolveAppArtifact(appSource) : undefined;

        const server = await ensureAppiumServer(testInfo.workerIndex);
        const capabilities = buildCapabilities({
          device,
          app,
          capabilities: appium?.capabilities,
        });
        session = await createSession({ baseUrl: server.baseUrl, capabilities });

        await use(toCallableApp(session));
      } finally {
        if (session) {
          const failed = testInfo.status !== testInfo.expectedStatus;
          if (shouldTakeScreenshot(screenshotModeOf(screenshot), testInfo.retry, failed)) {
            try {
              const screenshotPath = testInfo.outputPath('appium-screenshot.png');
              await session.saveScreenshot(screenshotPath);
              testInfo.attachments.push({
                name: 'appium-screenshot',
                path: screenshotPath,
                contentType: 'image/png',
              });
            } catch {
              /* best-effort — never let screenshot capture mask the real test result */
            }
          }
        }

        // Close the session BEFORE stopping the recording/device log so the driver has released the
        // device before we read its OS-level state.
        await closeSession(session);

        if (recording && videoPath) {
          const produced = await recording.stop();
          const failed = testInfo.status !== testInfo.expectedStatus;
          if (produced && shouldKeepRecording(videoMode, testInfo.retry, failed)) {
            testInfo.attachments.push({
              name: 'appium-recording',
              path: videoPath,
              contentType: 'video/mp4',
            });
          }
        }

        if (deviceLogEnabled) {
          try {
            const log =
              device.platform === 'android'
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
      }
    },
    { box: true },
  ],
});

export { expect };
