# @pwtap/plugin-appium

Mobile testing for the [Playwright Test Automation Platform](https://www.npmjs.com/package/@pwtap/create) via [Appium](https://appium.io) — Android (UiAutomator2) + iOS simulator (XCUITest), macOS-first. One `app` fixture: a **raw WebdriverIO session**, no curated facade on top.

[![npm](https://img.shields.io/npm/v/@pwtap/plugin-appium)](https://www.npmjs.com/package/@pwtap/plugin-appium)

## Install

Into a `@pwtap` project (wires the fixture, an env-gated `appium` project, env keys, and examples):

```bash
npx create-pwtap add appium
```

## The `app` fixture

```ts
import { test, expect } from '@fixtures';
import { devices } from '@pwtap/plugin-appium';

test.use({ appium: devices.android }); // or { platform: 'android', device: 'Pixel_API_35' }

test('sign in', async ({ app }) => {
  await app('~Login').click();
  await app('~Username').setValue('cihan');
  const dashboard = app('~Dashboard');
  await expect.poll(() => dashboard.isDisplayed()).toBe(true);
});
```

`app` is callable as a selector shorthand — `app('~Login')` is `app.$('~Login')` — and still the full
[WebdriverIO `Browser`](https://webdriver.io/docs/api/browser) otherwise: every protocol command and
element method is available directly on it (`$$`, `execute('mobile: ...')`, `saveScreenshot`, …).
Unlike `@pwtap/plugin-maestro`, there is **no per-command step reporting** — wrapping raw WebdriverIO
calls one-by-one isn't worth the maintenance cost of proxying its full API, so wrap your own
`test.step()` around a logical action if you want that in the report. WebdriverIO elements don't
auto-wait like Playwright locators either — `expect.poll(...)` gives you the same retry-until-true
behavior.

Installing an app under test: pass `app` (a local path or http(s) URL to an APK / iOS `.app`/`.zip`)
in the `appium` option, or set `APPIUM_APP_ANDROID`/`APPIUM_APP_IOS` — it becomes the `appium:app`
capability, so the **driver** installs it during session creation (no separate adb/simctl step). For
a built-in app (e.g. the Settings/Preferences example), skip `app` and target it directly via the
`capabilities` escape hatch (`appium:appPackage`/`appium:appActivity` on Android, `appium:bundleId` on
iOS) — see the scaffolded `tests/appium/settings.appium.ts`.

## Locators

Priority order (fastest/most stable first): accessibility ID (`~loginButton`, works on both
platforms), Android UiAutomator (`android=new UiSelector().text("Login")`), iOS Predicate String
(`-ios predicate string:label == "Login"`) or Class Chain, then XPath as a last resort — it's the
slowest strategy and the most brittle across app updates:

```ts
const submit =
  device.platform === 'android'
    ? app('android=new UiSelector().text("Submit")')
    : app('-ios predicate string:label == "Submit"');
await submit.waitForDisplayed({ timeout: 10_000 });
await submit.click();
```

See `docs/APPIUM_TESTING.md` (scaffolded into your project) for the full locator reference, waiting
patterns, and gesture commands (`execute('mobile: scrollGesture' | 'mobile: swipe', {...})`).

## Running

```bash
npm run test:appium          # APPIUM=1 playwright test --project=appium
```

A bare `npm test` stays UI + API — the `appium` project is gated behind `APPIUM=1`.

## The Appium server

By default the fixture spawns the `appium` CLI itself, one server per Playwright worker
(`4723 + workerIndex`), and waits for `GET /status` to report ready. Point at a server you manage
yourself instead with `APPIUM_SERVER_URL` (its lifecycle is then your responsibility). Override the
binary with `APPIUM_BIN` if `appium` isn't the right name on PATH.

## Parallel (the device pool)

The `appium` project is `fullyParallel`, and each test reserves its device with a cross-process lock
(`<platform>:<device>`). That pairing **is** the device pool: tests on the **same** device serialize
(they wait, not skip); tests on **different** devices or platforms run **concurrently**:

```bash
APPIUM=1 npx playwright test --project=appium --workers=3
```

## Devices

Select with `test.use({ appium })`: a named `device` (Android AVD / iOS simulator name or UDID)
auto-boots if not running; omit it to use any booted device. **When no matching device is available
the test skips (never fails).** Create a device via Android Studio's AVD Manager / Xcode's Simulator
app — or, if `@pwtap/plugin-maestro` is also installed, its `npm run mobile:create-device` script.

Devices the framework **auto-booted** are shut down **automatically** after the run by the
`appium-teardown` project (headed or headless) — set `APPIUM_KEEP_DEVICES=1` to keep them for faster
reruns. Devices you booted yourself are left running. This registry is **shared** with
`@pwtap/plugin-maestro` — running both plugins in one project still shuts every auto-booted device
down exactly once.

## Evidence — video, screenshot, device log

**Screen recording and screenshots aren't mobile-specific settings** — this fixture reads Playwright's
own built-in `video`/`screenshot` options (`use.video`/`use.screenshot` in `playwright.config.ts`, or a
project/describe override), so one central setting controls both for chromium **and** appium alike:
all seven video modes (`off` / `on` / `retain-on-failure` / `on-first-retry` / `on-all-retries` /
`retain-on-first-failure` / `retain-on-failure-and-retries`), and all four screenshot modes
(`off` / `on` / `only-on-failure` / `on-first-failure`) — captured **once at test end** (Appium has no
per-command concept like Maestro's step screenshots):

```ts
// playwright.config.ts
use: { video: 'retain-on-failure', screenshot: 'only-on-failure' }, // now applies to appium too
```

**`APPIUM_DEVICE_LOG=1`** attaches the device's own system log for the whole test (Android `logcat`,
iOS the unified system log) — off by default.

## Requirements

- **Appium CLI** (`npm install -g appium`) + the **`uiautomator2`**/**`xcuitest`** drivers
  (`appium driver install uiautomator2` / `xcuitest`).
- **Android**: Android SDK (`ANDROID_HOME`) + an emulator. **iOS**: Xcode + a simulator (simulator-only; real iOS devices are not yet supported).
- Node ≥ 20.19. `create-pwtap add appium` runs an advisory host check for these.

## License

MIT
