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

## Report — real per-step logs

Every replayed step attaches the actual data Maestro produced for it (`maestro-step-log`), not a
synthesized summary:

- **Imperative** — the exact YAML command sent over MCP + Maestro's raw response text for that call.
- **Batch YAML** — the exact JSON entry from Maestro's `debug/commands-*.json` for that command (the
  same source the step's label/status/duration come from, in full).

A **failing** step always attaches its log. On a **passing** step it's opt-in — set
`MOBILE_STEP_LOGS=1` to attach one on every step too.

## The AI judge

`maestro.takeScreenshot(name)` attaches the image to the report and returns its path — pipe it into
the AI judge (if installed): `await expect({ image: await maestro.takeScreenshot('home'), rubric }).toPassRubric()`.
This is an explicit, on-demand capture — unrelated to the automatic screenshot/video capture below.

## Device logs

`MOBILE_DEVICE_LOG=1` attaches the device's own system log for the whole test as `device-log`:
Android's `logcat` (cleared at test start, dumped at test end) or iOS's unified system log
(`log show`, windowed to the test's duration). This is the OS's log, distinct from Maestro's own
`maestro-log`/`maestro-step-log` — useful for app-side crashes or native errors Maestro doesn't see.
Off by default (extra shell calls per test); best-effort — a capture failure never fails or masks the
real test result.

## Screenshots and screen recording — controlled by Playwright's own config

Neither is a mobile-specific setting. The `maestro` fixture reads Playwright's own built-in
`video`/`screenshot` options — the same ones `chromium`/`page` tests use — so **one central setting
governs both for every project**, mobile included:

```ts
// playwright.config.ts
export default defineConfig({
  use: { video: 'retain-on-failure', screenshot: 'only-on-failure' }, // now covers maestro too
});
```

Override per file/project the same way you would for any Playwright option (`test.use({ video,
screenshot })`, or a project's own `use` block). Every mode of both options is honored, including the
attempt-scoped ones (checked against `testInfo.retry`: `0` on the first attempt, `1` on the first
retry, …):

**`video`** — attaches as `maestro-recording` (Android via `adb shell screenrecord`, iOS via
`simctl io recordVideo`):

| Mode                            | Behavior                                                        |
| ------------------------------- | --------------------------------------------------------------- |
| `off`                           | Never record.                                                   |
| `on`                            | Record and keep every run.                                      |
| `retain-on-failure`             | Record every run; keep only if it failed.                       |
| `retain-on-first-failure`       | Record only the first attempt; keep it only if that one failed. |
| `on-first-retry`                | Record (and keep) only the first retry.                         |
| `on-all-retries`                | Record (and keep) any retry attempt.                            |
| `retain-on-failure-and-retries` | Record every run; keep if it failed or it's a retry.            |

**`screenshot`** — on a Maestro command failure, attaches `failure.jpg` + `failure-hierarchy.json`;
`on` additionally captures after every successful command (a visual timeline):

| Mode               | Behavior                                                                     |
| ------------------ | ---------------------------------------------------------------------------- |
| `off`              | Never capture.                                                               |
| `only-on-failure`  | Capture only when a command fails (the default if unset).                    |
| `on`               | Also capture after every successful command.                                 |
| `on-first-failure` | Capture on failure, but only on the first attempt — retries capture nothing. |

Both are best-effort: a capture failure never fails or masks the real test result.

## Environment variables

| Key                                     | Purpose                                                          |
| --------------------------------------- | ---------------------------------------------------------------- |
| `MOBILE_PLATFORM`                       | Default platform (`android` / `ios`) when a test doesn't set one |
| `MOBILE_DEVICE`                         | Default device name/UDID                                         |
| `MOBILE_HEADLESS`                       | `true` (default) hides the device; `false` shows it              |
| `MOBILE_APP_ANDROID` / `MOBILE_APP_IOS` | App under test (path or URL), installed before the flow          |
| `MOBILE_STEP_LOGS`                      | Attach a step's real log on success too (default: failure only)  |
| `MOBILE_DEVICE_LOG`                     | `1` attaches the device's OS system log for the whole test       |
| `MOBILE_KEEP_DEVICES`                   | Keep auto-booted devices after the run (faster reruns)           |
| `MAESTRO_BIN`                           | Path to the Maestro binary (defaults to `maestro` on PATH)       |

Screenshots and screen recording are configured via Playwright's own `use.screenshot`/`use.video`
(see above), not env keys.

## Prerequisites

The Maestro CLI + a JDK 17+, plus an Android SDK (`ANDROID_HOME`) or Xcode for the platform you
target. `npx create-pwtap add maestro` runs an advisory check and points at anything missing. iOS is
simulator-only today; real iOS devices are not yet supported.
