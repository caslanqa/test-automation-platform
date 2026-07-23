# @pwtap/plugin-maestro

Mobile testing for the [Playwright Test Automation Platform](https://www.npmjs.com/package/@pwtap/create) via [Maestro](https://maestro.mobile.dev) — Android + iOS simulator, macOS-first. One `maestro` fixture, two authoring styles you can mix in a single test.

[![npm](https://img.shields.io/npm/v/@pwtap/plugin-maestro)](https://www.npmjs.com/package/@pwtap/plugin-maestro)

## Install

Into a `@pwtap` project (wires the fixture, an env-gated `maestro` project, env keys, and examples):

```bash
npx create-pwtap add maestro
```

## Two styles, mixable

```ts
import { test, expect } from '@fixtures';
import { devices } from '@pwtap/plugin-maestro';

test.use({ mobile: devices.android }); // or { platform: 'android', device: 'Pixel_API_35' }

// Imperative (Playwright-style) — each call is one Maestro command against a warm device driver:
test('sign in', async ({ maestro }) => {
  await maestro.launchApp('com.example.app');
  await maestro.tapOn('Login');
  await maestro.inputText('cihan');
  if (await maestro.isVisible('Cookie banner')) await maestro.tapOn('Accept');
  await maestro.assertVisible('Dashboard');
});

// Batch YAML — run an authored flow file:
test('smoke flow', async ({ maestro }) => {
  await maestro.run('tests/maestro/flows/android/login.yaml');
});
```

The imperative surface covers `launchApp`, `tapOn`/`doubleTapOn`/`longPressOn`, `inputText`/`eraseText`, `assertVisible`/`assertNotVisible`, `isVisible` (branch in TS — never fails), `scroll`/`scrollUntilVisible`/`swipe`, `back`/`pressKey`/`hideKeyboard`, `takeScreenshot`, `inspectScreen`, and `rowValue`. Each command shows as a native Playwright step; YAML flows are replayed step-by-step in the report too.

## Running

```bash
npm run test:maestro          # MAESTRO=1 playwright test --project=maestro
```

A bare `npm test` stays UI + API — the `maestro` project is gated behind `MAESTRO=1`.

## Parallel (the device pool)

The `maestro` project is `fullyParallel`, and each test reserves its device with a cross-process
lock (`<platform>:<device>`). That pairing **is** the device pool: tests on the **same** device
serialize (they wait, not skip); tests on **different** devices or platforms run **concurrently**.
Give each test its device and run with workers:

```bash
MAESTRO=1 npx playwright test --project=maestro --workers=3
```

Concurrent flows across devices need Maestro ≳ 2.6 (older builds pin a fixed driver port); on older
Maestro the plugin falls back to a single shared lock so `--workers>1` stays safe. Force with
`MOBILE_PARALLEL=1`.

## Devices

Select with `test.use({ mobile })`: a named `device` (Android AVD / iOS simulator name or UDID)
auto-boots if not running; omit it to use any booted device. **When no matching device is available
the test skips (never fails).**

```bash
npm run mobile:create-device      # create an AVD / simulator (interactive)
npm run mobile:stop-devices       # manually shut down framework-booted devices
```

Devices the framework **auto-booted** are shut down **automatically** after the run by the
`maestro-teardown` project (headed or headless) — set `MOBILE_KEEP_DEVICES=1` to keep them for faster
reruns. Devices you booted yourself are left running.

## Report — real per-step logs

Every step's log is the actual data Maestro produced for it, not a synthesized summary:

- **Imperative** — the command sent + Maestro's raw MCP response text.
- **Batch YAML** — the exact JSON entry Maestro recorded for that command (command + metadata).

A failing step **always** attaches its log; on success it's opt-in (`MOBILE_STEP_LOGS=1`) so passing
runs stay quiet by default. On failure, imperative commands also attach a screenshot + view hierarchy
at the point of failure.

**`MOBILE_DEVICE_LOG=1`** attaches the device's own system log for the whole test (Android `logcat`,
iOS the unified system log) — off by default.

**Screen recording and screenshots aren't mobile-specific settings** — this fixture reads Playwright's
own built-in `video`/`screenshot` options (`use.video`/`use.screenshot` in `playwright.config.ts`, or a
project/describe override), so one central setting controls both for chromium **and** maestro alike:
all seven video modes (`off` / `on` / `retain-on-failure` / `on-first-retry` / `on-all-retries` /
`retain-on-first-failure` / `retain-on-failure-and-retries`) and all four screenshot modes
(`off` / `on` / `only-on-failure` / `on-first-failure`):

```ts
// playwright.config.ts
use: { video: 'retain-on-failure', screenshot: 'only-on-failure' }, // now applies to maestro too
```

## Requirements

- **Maestro CLI** + a **JDK 17+**.
- **Android**: Android SDK (`ANDROID_HOME`) + an emulator. **iOS**: Xcode + a simulator (simulator-only; real iOS devices are not yet supported).
- Node ≥ 20.19. `create-pwtap add maestro` runs an advisory host check for these.

## License

MIT
