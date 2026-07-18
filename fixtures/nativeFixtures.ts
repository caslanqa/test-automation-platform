import { test as base, expect } from '@playwright/test';

import { loadEnv } from '@config/loadEnv';
import { ensureAppiumServer } from '@native/core/appiumServer';
import { NativeSession, type NativeDriver } from '@native/core/NativeSession';
import type { NativeAppConfig, NativePlatform, NativeSelector } from '@native/core/types';

// Load the selected environment (NATIVE_APP / NATIVE_PLATFORM / NATIVE_SERVER_URL → process.env)
// before any test runs.
loadEnv();

/** Options this test object adds. */
export interface NativeOptions {
  /**
   * Native desktop app selection. Set per file/describe with
   * `test.use({ native: { app: 'textEdit' } })`.
   * - `app` names a catalogued app (native/apps.ts); falls back to the `NATIVE_APP` env var.
   * - `platform` (`mac` | `windows`) falls back to `NATIVE_PLATFORM`, then `mac`.
   * - point at your own app inline with `bundleId`/`appPath` (macOS) or `windowsApp`/`appPath`
   *   (Windows); `args` / `env` / `serverUrl` are passed through.
   *
   * The app is driven over Appium (WebDriver) — NOT a Playwright `Page` — so assertions use the
   * `app` fixture's methods below plus `expectAi` on a screenshot. See docs/NATIVE_TESTING.md.
   */
  native: NativeAppConfig | undefined;
}

/** The runtime facade a native test uses: an imperative command surface over the Appium session. */
export interface NativeAppFixture {
  /** The platform this run resolved to. */
  platform: NativePlatform;
  /** Click/press an element. */
  click(selector: NativeSelector): Promise<void>;
  /** Replace an editable element's value. */
  setValue(selector: NativeSelector, text: string): Promise<void>;
  /** Append text to an editable element. */
  addValue(selector: NativeSelector, text: string): Promise<void>;
  /** Clear an editable element. */
  clear(selector: NativeSelector): Promise<void>;
  /** Read an element's text. */
  getText(selector: NativeSelector): Promise<string>;
  /** Whether an element is visible within `timeout` ms (default 2000) — for branching, never fails. */
  isVisible(selector: NativeSelector, options?: { timeout?: number }): Promise<boolean>;
  /** Assert an element is visible. */
  assertVisible(selector: NativeSelector, options?: { timeout?: number }): Promise<void>;
  /** Assert an element is not visible. */
  assertNotVisible(selector: NativeSelector, options?: { timeout?: number }): Promise<void>;
  /**
   * Screenshot the app, attach it to the report as `<name>`, and return the file path — pipe it into
   * the AI judge: `expectAi({ image: await app.takeScreenshot('home'), rubric })`.
   */
  takeScreenshot(name: string): Promise<string>;
  /** The current screen's UI tree as page-source XML — for TypeScript branching / assertions. */
  source(): Promise<string>;
  /** Run a driver command (escape hatch, e.g. `execute('macos: appleScript', { command })`). */
  execute(script: string, ...args: unknown[]): Promise<unknown>;
  /** The raw webdriverio session — escape hatch for driver-specific commands. */
  raw: NativeDriver;
}

interface NativeFixtures {
  app: NativeAppFixture;
}

/** Merge the per-test `native` option with the `NATIVE_APP` env fallback. */
function resolveConfig(option: NativeOptions['native']): NativeAppConfig {
  const config: NativeAppConfig = { ...(option ?? {}) };
  if (!config.app && !config.bundleId && !config.appPath && !config.windowsApp) {
    config.app = process.env.NATIVE_APP || undefined;
  }
  return config;
}

/**
 * Native desktop test object. Adds a `native` selection option and an `app` fixture that opens an
 * Appium session against a running (or auto-started) Appium server and bridges screenshot + page-source
 * evidence into the report. When no Appium server/driver is available the test is SKIPPED (not failed),
 * so the suite stays green on machines without the toolchain. Import directly:
 * `import { test, expect } from '@fixtures/nativeFixtures'`.
 */
export const test = base.extend<NativeOptions & NativeFixtures>({
  native: [undefined, { option: true }],

  // `box: true` hides this fixture from the report's Before/After Hooks — the native test shows just
  // its own steps, matching how the mobile `maestro` and desktop `electron` fixtures are boxed.
  app: [
    async ({ native }, use, testInfo) => {
      const baseUrl = await ensureAppiumServer(native?.serverUrl);
      if (!baseUrl) {
        testInfo.skip(
          true,
          '[native] no Appium server available — install it (`npm i -D appium` + ' +
            '`npx appium driver install mac2`) so it auto-starts, or run `appium` yourself. ' +
            'See docs/NATIVE_TESTING.md'
        );
        return;
      }
      const session = new NativeSession(
        {
          outputDir: testInfo.outputDir,
          // `testInfo.attach` so a screenshot/source binds to the current step (failure evidence shows
          // under the failing step in the report and trace).
          report: (name, attachment) => testInfo.attach(name, attachment),
        },
        baseUrl
      );
      try {
        await session.launch(resolveConfig(native));
        const raw = session.requireDriver();
        await use({
          platform: session.platformName,
          click: selector => session.click(selector),
          setValue: (selector, text) => session.setValue(selector, text),
          addValue: (selector, text) => session.addValue(selector, text),
          clear: selector => session.clear(selector),
          getText: selector => session.getText(selector),
          isVisible: (selector, options) => session.isVisible(selector, options),
          assertVisible: (selector, options) => session.assertVisible(selector, options),
          assertNotVisible: (selector, options) => session.assertNotVisible(selector, options),
          takeScreenshot: name => session.takeScreenshot(name),
          source: () => session.source(),
          execute: (script, ...args) => session.execute(script, ...args),
          raw,
        });
      } finally {
        // Attach failure evidence (screenshot + source) and delete the Appium session.
        await session.close(testInfo);
      }
    },
    { box: true },
  ],
});

export { expect };
