/** Native desktop-testing domain types. The native engine is Appium (WebDriver over a server). */

/** Supported native desktop platforms (Appium drivers: `mac2` / `windows`). */
export type NativePlatform = 'mac' | 'windows';

/**
 * An element selector for the imperative native commands (`click`, `assertVisible`, …). Either:
 * - a **string** — passed to webdriverio verbatim, so any selector strategy it accepts works
 *   (`~accessibilityId`, an XPath `//…`, a predicate string, etc.); or
 * - a **structured object** — the two cross-driver-reliable strategies: `{ accessibilityId }`
 *   (→ `~id`) or `{ xpath }` (used as-is).
 */
export type NativeSelector = string | { accessibilityId?: string; xpath?: string };

/**
 * Native app selection / launch config. Set per file/describe with
 * `test.use({ native: { app: 'textEdit' } })`, or point at your own app. What gets launched, per
 * platform: macOS uses `bundleId` or `appPath`; Windows uses `windowsApp` (an app id or an `.exe`
 * path, falling back to `appPath`). A named `app` looks the fields up in the catalog (native/apps.ts);
 * `platform` / `app` fall back to the `NATIVE_PLATFORM` / `NATIVE_APP` env vars.
 */
export interface NativeAppConfig {
  /** A named entry in the app catalog (native/apps.ts), e.g. `'textEdit'`. Falls back to `NATIVE_APP`. */
  app?: string;
  /** Target platform. Falls back to `NATIVE_PLATFORM`, then `'mac'`. */
  platform?: NativePlatform;
  /** macOS: the app's bundle identifier (e.g. `com.apple.TextEdit`). */
  bundleId?: string;
  /** macOS: absolute path to a `.app` bundle (alternative to `bundleId`). Also usable as a Windows path. */
  appPath?: string;
  /** Windows: the app id (AUMID) or absolute `.exe` path (Appium `appium:app`); falls back to `appPath`. */
  windowsApp?: string;
  /** Extra CLI args passed to the app on launch. */
  args?: string[];
  /** Extra environment variables for the launched app (macOS `appium:environment`). */
  env?: Record<string, string>;
  /** Appium server base URL (default `http://127.0.0.1:4723`). Falls back to `NATIVE_SERVER_URL`. */
  serverUrl?: string;
}
