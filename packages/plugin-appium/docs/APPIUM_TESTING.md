# Mobile testing (Appium)

Mobile tests are driven by [Appium](https://appium.io), orchestrated by Playwright. The `app` fixture
is a **raw WebdriverIO session, callable as a selector shorthand** (`app('~Login')` is
`app.$('~Login')`) — the full driver API, no curated facade on top — plus device discovery/boot/lock
and Playwright-config-driven evidence capture shared with `@pwtap/plugin-maestro`.

## The `app` fixture

```ts
import { test, expect } from '@fixtures';
import { devices } from '@pwtap/plugin-appium';

test.use({ appium: devices.android });

test('search', async ({ app }) => {
  await app('~Search settings').click();
  await app('android=new UiSelector().text("battery")').setValue('battery');
  const result = app('~Battery');
  await expect.poll(() => result.isDisplayed()).toBe(true);
});
```

`app` is callable as a selector shorthand — `app('~Battery')` is `app.$('~Battery')` — and still the
full [WebdriverIO `Browser`](https://webdriver.io/docs/api/browser) instance otherwise: every other
protocol command (`$$`, `click`, `setValue`, `getText`, `waitForExist`, `execute('mobile: ...')`, …)
is available directly on it. There is **no per-command step reporting** like Maestro's — proxying
WebdriverIO's entire API into Playwright steps would be a large, ongoing maintenance surface for
little benefit; wrap a logical action in your own `test.step()` if you want it in the report.
WebdriverIO elements also don't auto-wait like Playwright locators — use `expect.poll(...)` for
retry-until-true assertions.

## Writing tests: locators

`app` gives you every WebdriverIO selector strategy. Priority order (fastest/most stable first,
XPath last resort — the same guidance WebdriverIO gives for any mobile automation):

| Strategy                     | Syntax                                                                   | Platform |
| ---------------------------- | ------------------------------------------------------------------------ | -------- |
| Accessibility ID (preferred) | `app('~loginButton')`                                                    | both     |
| Android UiAutomator          | `app('android=new UiSelector().text("Login")')`                          | Android  |
| iOS Predicate String         | `app('-ios predicate string:label == "Login"')`                          | iOS      |
| iOS Class Chain              | `app('-ios class chain:**/XCUIElementTypeButton[\`label == "Login"\`]')` | iOS      |
| XPath (last resort — slow)   | `app('//XCUIElementTypeButton[@label="Login"]')`                         | both     |

Accessibility ID (`~`) works identically on both platforms and is the one to reach for first — it
maps to `content-desc` on Android and `accessibilityIdentifier`/`accessibilityLabel` on iOS. Common
UiSelector methods: `.text()`, `.textContains()`, `.resourceId()`, `.className()`, `.description()`
— chainable (`new UiSelector().className("android.widget.Button").text("Login")`). Common predicate
operators: `==`, `CONTAINS`, `BEGINSWITH`, `AND`/`OR`, `==[c]` (case-insensitive).

For a test that must run on both platforms, branch on `device.platform`:

```ts
test('login', async ({ app, device }) => {
  const loginButton =
    device.platform === 'android'
      ? app('android=new UiSelector().text("Login")')
      : app('-ios predicate string:label == "Login"');
  await loginButton.click();
});
```

Or just use `~accessibilityId` everywhere and set matching accessibility identifiers in the app under
test — the simplest cross-platform strategy when you control the app.

## Writing tests: waiting, multiple elements, gestures

WebdriverIO elements don't auto-wait like Playwright locators. Use the built-in wait commands before
interacting, or `expect.poll(...)` for assertions:

```ts
const submit = app('~submit');
await submit.waitForDisplayed({ timeout: 10_000 }); // throws if it times out
await submit.click();

const banner = app('~cookie-banner');
if (await banner.isDisplayed()) {
  await banner.$('~accept').click(); // nested lookup on an element — use `.$()`, only `app` itself is callable
}
```

`waitForExist`, `waitForEnabled`, and `waitForClickable` follow the same `{ timeout, reverse }`
shape. Multiple matches: `app.$$('android=new UiSelector().className("android.widget.TextView")')`
returns an array-like collection you can iterate or index — `$$` is not part of the callable
shorthand (only single-element `$` is), so always call it as `app.$$(...)`.

Gestures beyond `click`/`setValue` go through `execute('mobile: ...', {...})` — the command name is
platform-specific:

```ts
// Android
await app.execute('mobile: scrollGesture', {
  elementId: (await app('~list')).elementId,
  direction: 'down',
  percent: 0.75,
});
await app.execute('mobile: swipeGesture', {
  left: 0,
  top: 0,
  width: 200,
  height: 400,
  direction: 'left',
  percent: 0.75,
});

// iOS
await app.execute('mobile: scroll', { direction: 'down' });
await app.execute('mobile: swipe', { direction: 'left' });
```

Reaching for a logical grouping in the report: since there's no automatic per-command step (see
above), wrap a multi-call action in your own step —
`await test.step('log in', async () => { await app('~user').setValue('cihan'); await app('~submit').click(); })`.

## Selecting a device

```ts
test.use({ appium: { platform: 'android', device: 'Pixel_API_35' } });
test.use({ appium: { platform: 'ios', device: 'iPhone 16 Pro', headless: false } });
test.use({ appium: devices.android }); // any booted android device
```

- `device` — Android AVD name, or iOS simulator name/UDID. If it isn't booted, it's booted for you.
  A plugged-in Android device works too (target it by serial). **No matching device → the test skips.**
- `headless` — hidden by default; `false` shows the emulator window / Simulator app.
- `app` — a local path or http(s) URL to an APK / iOS `.app`/`.zip`. Becomes the `appium:app`
  capability, so the **driver** installs it during session creation — no separate adb/simctl step.
- `capabilities` — an escape hatch for anything not covered above (e.g. `appium:appPackage` /
  `appium:appActivity` on Android, `appium:bundleId` on iOS, to target a built-in app with no `app`
  artifact), merged on top of the computed capabilities.

Create devices via Android Studio's AVD Manager / Xcode's Simulator app, or — if
`@pwtap/plugin-maestro` is also installed — its `npm run mobile:create-device` script (the
booted-device registry is shared, so either plugin's teardown shuts down every auto-booted device).
Devices the framework auto-booted are shut down **automatically** after the run by the
`appium-teardown` project (headed or headless). Set `APPIUM_KEEP_DEVICES=1` to keep auto-booted
devices for faster reruns. Devices you booted yourself are left running.

## Running & parallelism

```bash
npm run test:appium                                        # APPIUM=1 playwright test --project=appium
APPIUM=1 npx playwright test --project=appium --workers=3  # parallel across devices
```

A bare `npm test` runs only chromium + api — the `appium` project is gated behind `APPIUM=1`.

The `appium` project is `fullyParallel`, and each test reserves its device with a cross-process lock
keyed `<platform>:<device>` — **this is the device pool**: same device → serialize (wait, not skip),
different devices/platforms → run concurrently. Give each test its own device and add `--workers=N`.

## The Appium server

The fixture spawns the `appium` CLI itself by default, one server per Playwright worker process
(`4723 + workerIndex`), and polls `GET /status` until `ready: true`. Set `APPIUM_SERVER_URL` to connect
to a server you manage yourself instead (its lifecycle is then your responsibility — the fixture only
connects, never spawns or stops it). `APPIUM_BIN` overrides the binary name/path if `appium` isn't
right for your setup.

## Device logs

`APPIUM_DEVICE_LOG=1` attaches the device's own system log for the whole test as `device-log`:
Android's `logcat` (cleared at test start, dumped at test end) or iOS's unified system log (`log
show`, windowed to the test's duration). Off by default (extra shell calls per test); best-effort — a
capture failure never fails or masks the real test result.

## Screenshots and screen recording — controlled by Playwright's own config

Neither is a mobile-specific setting. The `app` fixture reads Playwright's own built-in
`video`/`screenshot` options — the same ones `chromium`/`page` tests use — so **one central setting
governs both for every project**, mobile included:

```ts
// playwright.config.ts
export default defineConfig({
  use: { video: 'retain-on-failure', screenshot: 'only-on-failure' }, // now covers appium too
});
```

Override per file/project the same way you would for any Playwright option (`test.use({ video,
screenshot })`, or a project's own `use` block). Every mode of both options is honored, including the
attempt-scoped ones (checked against `testInfo.retry`: `0` on the first attempt, `1` on the first
retry, …):

**`video`** — attaches as `appium-recording` (Android via `adb shell screenrecord`, iOS via `simctl io
recordVideo` — the same platform primitives Maestro uses, not an Appium-native recording command):

| Mode                            | Behavior                                                        |
| ------------------------------- | --------------------------------------------------------------- |
| `off`                           | Never record.                                                   |
| `on`                            | Record and keep every run.                                      |
| `retain-on-failure`             | Record every run; keep only if it failed.                       |
| `retain-on-first-failure`       | Record only the first attempt; keep it only if that one failed. |
| `on-first-retry`                | Record (and keep) only the first retry.                         |
| `on-all-retries`                | Record (and keep) any retry attempt.                            |
| `retain-on-failure-and-retries` | Record every run; keep if it failed or it's a retry.            |

**`screenshot`** — attaches as `appium-screenshot`, captured **once when the test ends** (Appium has
no per-command concept the way Maestro's step screenshots do):

| Mode               | Behavior                                               |
| ------------------ | ------------------------------------------------------ |
| `off`              | Never capture.                                         |
| `only-on-failure`  | Capture only if the test failed (the default if unset) |
| `on`               | Always capture at test end.                            |
| `on-first-failure` | Capture on failure, but only on the first attempt.     |

Both are best-effort: a capture failure never fails or masks the real test result.

## Environment variables

| Key                                     | Purpose                                                                |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `APPIUM_PLATFORM`                       | Default platform (`android` / `ios`) when a test doesn't set one       |
| `APPIUM_DEVICE`                         | Default device name/UDID                                               |
| `APPIUM_HEADLESS`                       | `true` (default) hides the device; `false` shows it                    |
| `APPIUM_APP_ANDROID` / `APPIUM_APP_IOS` | App under test (path or URL) — set as the `appium:app` capability      |
| `APPIUM_SERVER_URL`                     | Connect to an externally-managed Appium server instead of spawning one |
| `APPIUM_DEVICE_LOG`                     | `1` attaches the device's OS system log for the whole test             |
| `APPIUM_KEEP_DEVICES`                   | Keep auto-booted devices after the run (faster reruns)                 |
| `APPIUM_BIN`                            | Path to the Appium binary (defaults to `appium` on PATH)               |

Screenshots and screen recording are configured via Playwright's own `use.screenshot`/`use.video`
(see above), not env keys.

## Prerequisites

The Appium CLI (`npm install -g appium`) plus the `uiautomator2`/`xcuitest` drivers (`appium driver
install uiautomator2` / `xcuitest`), and an Android SDK (`ANDROID_HOME`) or Xcode for the platform you
target. `npx create-pwtap add appium` runs an advisory check and points at anything missing. iOS is
simulator-only today; real iOS devices are not yet supported.
