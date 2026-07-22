# Mobile testing (Maestro)

Mobile tests are driven by [Maestro](https://maestro.mobile.dev), orchestrated by Playwright. The
`maestro` fixture gives you two authoring styles you can mix in one test, and bridges Maestro's
artifacts (steps, screenshots, JUnit, logs) into the Playwright HTML report and trace.

## The two styles

**Imperative (Playwright-style)** — each call runs one Maestro command against a warm on-device
driver (`maestro mcp`), so it executes and fails at that exact line, and you can branch in TypeScript
on the live screen:

```ts
import { test, expect } from '@fixtures';
import { devices } from '@pwtap/plugin-maestro';

test.use({ mobile: devices.android });

test('search', async ({ maestro }) => {
  await maestro.launchApp('com.android.settings');
  await maestro.tapOn('Search settings');
  await maestro.inputText('battery');
  await maestro.assertVisible('Battery');
});
```

**Batch YAML** — run an authored Maestro flow file; its commands are replayed as native Playwright
steps so the report marks exactly which step failed and why:

```ts
test('login flow', async ({ maestro }) => {
  await maestro.run('tests/maestro/flows/android/login.yaml');
});
```

The `maestro mcp` process is spawned lazily on the first imperative call, so batch-only tests never
pay for it.

## Selecting a device

```ts
test.use({ mobile: { platform: 'android', device: 'Pixel_API_35' } });
test.use({ mobile: { platform: 'ios', device: 'iPhone 16 Pro', headless: false } });
test.use({ mobile: devices.android }); // any booted android device
```

- `device` — Android AVD name, or iOS simulator name/UDID. If it isn't booted, it's booted for you.
  A plugged-in Android device works too (target it by serial). **No matching device → the test skips.**
- `headless` — hidden by default; `false` shows the emulator window / Simulator app.
- `app` — a local path or http(s) URL to an APK / iOS `.app`/`.zip`, installed once before the flow.

Create devices from your installed toolchain with `npm run mobile:create-device`. Devices the
framework auto-booted are shut down **automatically** after the run by the `maestro-teardown` project
(headed or headless); `npm run mobile:stop-devices` does it manually. Set `MOBILE_KEEP_DEVICES=1` to
keep auto-booted devices for faster reruns. Devices you booted yourself are left running.

## Running & parallelism

```bash
npm run test:maestro                                   # MAESTRO=1 playwright test --project=maestro
MAESTRO=1 npx playwright test --project=maestro --workers=3   # parallel across devices
```

A bare `npm test` runs only chromium + api — the `maestro` project is gated behind `MAESTRO=1`.

The `maestro` project is `fullyParallel`, and each test reserves its device with a cross-process lock
keyed `<platform>:<device>` — **this is the device pool**: same device → serialize (wait, not skip),
different devices/platforms → run concurrently. Give each test its own device and add `--workers=N`.
Concurrent flows across devices need Maestro ≳ 2.6 (older builds pin a fixed driver port and clash);
on older Maestro the plugin falls back to one shared lock so `--workers>1` stays safe (no speedup).
Force the behavior with `MOBILE_PARALLEL=1` / `0`.

## Screenshots and the AI judge

`maestro.takeScreenshot(name)` attaches the image to the report and returns its path — pipe it into
the AI judge (if installed): `await expect({ image: await maestro.takeScreenshot('home'), rubric }).toPassRubric()`.
Set `MOBILE_SCREENSHOT=on` to capture after every command (a visual timeline), or `off` to disable.

## Environment variables

| Key                                     | Purpose                                                          |
| --------------------------------------- | ---------------------------------------------------------------- |
| `MOBILE_PLATFORM`                       | Default platform (`android` / `ios`) when a test doesn't set one |
| `MOBILE_DEVICE`                         | Default device name/UDID                                         |
| `MOBILE_HEADLESS`                       | `true` (default) hides the device; `false` shows it              |
| `MOBILE_APP_ANDROID` / `MOBILE_APP_IOS` | App under test (path or URL), installed before the flow          |
| `MOBILE_SCREENSHOT`                     | `only-on-failure` (default) / `on` / `off`                       |
| `MOBILE_KEEP_DEVICES`                   | Keep auto-booted devices after the run (faster reruns)           |
| `MAESTRO_BIN`                           | Path to the Maestro binary (defaults to `maestro` on PATH)       |

## Prerequisites

The Maestro CLI + a JDK 17+, plus an Android SDK (`ANDROID_HOME`) or Xcode for the platform you
target. `npx create-pwtap add maestro` runs an advisory check and points at anything missing. iOS is
simulator-only today; real iOS devices are not yet supported.
