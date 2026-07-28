/**
 * @pwtap/create injection manifest for the Appium plugin. Adds an `appiumTest` fixture (merged into
 * the `@fixtures` barrel via mergeTests), an env-gated `appium` Playwright project (so a bare
 * `npm test` stays UI + API), the `APPIUM_*` env keys the engine reads, an example spec, and a host
 * check. The `appium` project sets no `testDir` — it inherits the project's top-level tests folder
 * (so it respects a renamed tests dir) and matches `*.appium.ts`.
 *
 * @example
 * // after `npx create-pwtap add appium`, gated behind APPIUM=1:
 * //   npm run test:appium   →  runs tests and auto-generates appium HTML report
 */
export const manifest = {
  id: 'appium',
  name: '@pwtap/plugin-appium',
  devDependencies: {},
  scripts: {
    'test:appium':
      'APPIUM=1 playwright test --project=appium; code=$?; node scripts/mobile/appium-report.mjs; exit $code',
    'mobile:create-device': 'node scripts/mobile/create-device.mjs',
    'mobile:stop-devices': 'node scripts/mobile/stop-devices.mjs',
    'mobile:inspect': 'mobile-inspect .',
    'report:appium': 'node scripts/mobile/appium-report.mjs',
  },
  envKeys: {
    APPIUM_PLATFORM: 'android',
    APPIUM_DEVICE: '',
    APPIUM_HEADLESS: 'true',
    APPIUM_APP_ANDROID: '',
    APPIUM_APP_IOS: '',
    APPIUM_SERVER_URL: '',
    APPIUM_DEVICE_LOG: '',
    APPIUM_DIAGNOSTICS: 'fail',
    APPIUM_KEEP_DEVICES: '',
    APPIUM_BIN: '',
  },
  fixture: [
    { importFrom: '@pwtap/plugin-appium', test: { alias: 'appiumTest' } },
    // The driver-neutral `mobileApp` facade every inspector-generated test uses. Marked `shared` because
    // @pwtap/plugin-maestro contributes the identical entry: it is injected once and, crucially, survives
    // removing one mobile plugin while the other is still installed.
    {
      importFrom: '@pwtap/mobile-inspector',
      test: { alias: 'mobileAppTest' },
      shared: true,
    },
  ],
  playwrightProject: {
    gateVar: 'appiumEnabled',
    gate: "const appiumEnabled = process.env.APPIUM === '1';",
    // fullyParallel + a per-device lock (in the fixture) = the device pool: tests on the SAME device
    // serialize, DIFFERENT devices/platforms run concurrently (with --workers). `teardown` runs the
    // appium-teardown project after the run, shutting down framework-booted devices automatically.
    // `timeout: 180_000` (vs. Playwright's 30s default) — XCUITest's FIRST session on a given
    // simulator/Xcode build rebuilds WebDriverAgent from scratch, which alone can take well over a
    // minute; a short timeout makes that look like iOS "randomly" never launching.
    project:
      "...(appiumEnabled ? [{ name: 'appium', testMatch: /.*\\.appium\\.ts$/, fullyParallel: true, timeout: 180_000, retries: 1, teardown: 'appium-teardown' }, { name: 'appium-teardown', testMatch: /appium\\.teardown\\.ts$/ }] : [])",
  },
  examples: [
    { src: 'templates/tests', dest: 'tests/appium' },
    { src: 'templates/scripts/mobile', dest: 'scripts/mobile' },
  ],
  docs: [{ src: 'docs/APPIUM_TESTING.md', dest: 'docs/APPIUM_TESTING.md' }],
  ensure: 'ensure',
  readmeSection: [
    '## Mobile (Appium)',
    '',
    'A raw WebdriverIO session, callable as a selector shorthand — no curated facade:',
    '',
    '```ts',
    "import { test, expect } from '@fixtures';",
    "import { devices } from '@pwtap/plugin-appium';",
    '',
    'test.use({ appium: devices.android });',
    '',
    "test('settings', async ({ app }) => {",
    "  await app('~Network & internet').click();",
    "  const internet = app('~Internet');",
    '  await expect.poll(() => internet.isDisplayed()).toBe(true);',
    '});',
    '```',
    '',
    'Runs gated: `npm run test:appium` (or `APPIUM=1 playwright test --project=appium`). A named',
    'device auto-boots; with none available the test skips. Needs the Appium CLI',
    '(`npm install -g appium`) plus the `uiautomator2`/`xcuitest` drivers, and an Android SDK / Xcode',
    'for the respective platform. Unlike `@pwtap/plugin-maestro`, there is no per-command step',
    'reporting — wrap calls in your own `test.step()` if you want that.',
    '',
    'Locators, in priority order: accessibility ID (`~loginButton`, cross-platform), Android',
    '`android=new UiSelector().text("Login")`, iOS `-ios predicate string:label == "Login"` /',
    '`-ios class chain:...`, XPath last resort. See `docs/APPIUM_TESTING.md` for the full reference.',
  ].join('\n'),
};
