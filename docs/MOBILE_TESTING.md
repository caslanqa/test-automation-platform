# Mobile Testing (Maestro)

Mobile tests are authored as [Maestro](https://maestro.mobile.dev) YAML flows and orchestrated by
Playwright: **Playwright is the runner/reporter, Maestro is the mobile execution engine** (invoked as
a CLI — no npm dependency). It's the fourth engine alongside web, API, and the AI Judge.

> In a hurry? The [Mobile Cheat Sheet](MOBILE_CHEATSHEET.md) has the day-to-day commands — listing
> device/app IDs, booting/installing, and the Maestro CLI.

## How it fits together

```text
tests/mobile/*.mobile.ts       Playwright specs: test.use({ mobile }) + maestro.run('<flow>.yaml')
        │
tests/mobile/flows/**/*.yaml   the Maestro flows they run (YAML-first)
        │
mobile/core/MaestroRunner.ts   spawns `maestro --device <id> test <flow> …`
mobile/core/DeviceManager.ts   finds (or boots) a device (adb / xcrun simctl)
```

- **Layer 1 — `MaestroRunner`** (`mobile/core/`): runs one flow on a device via the Maestro CLI and
  reports the exit code + artifact locations.
- **Layer 1 — `DeviceManager`**: finds a booted device for the platform — or, when you name one
  (`MOBILE_DEVICE` / `test.use({ mobile: { device } })`), **boots it and waits** until it's ready.
- **The specs** (`tests/mobile/*.mobile.ts`): read just like the UI and API tests —
  `test.use({ mobile: { platform, device } })` selects the device, and each `test()` calls
  `maestro.run('<flow>.yaml')`. The `maestro` fixture attaches Maestro's JUnit report + screenshots
  to each test.

## Prerequisites

- [Maestro](https://maestro.mobile.dev) on your PATH (`maestro --version`); needs Java 17+.
- A device — either boot one yourself, or let the framework boot it (see “Choosing the device” below):
  - **Android:** an emulator (AVD). The Android SDK is auto-detected from `ANDROID_HOME` /
    `ANDROID_SDK_ROOT` / the default location (macOS `~/Library/Android/sdk`, Linux `~/Android/Sdk`,
    Windows `%LOCALAPPDATA%\Android\Sdk`), so you usually don't need to export anything. To create an
    AVD with `npm run mobile:create-device` you also need the **command-line tools** — see below.
  - **iOS (macOS only):** an available Xcode simulator. No extra tooling to install.

### Installing the Android command-line tools

Only needed for **Android** `create-device` (it runs `sdkmanager`/`avdmanager`); iOS needs none of
this. Works on macOS, Windows and Linux — pick **one** path:

**A. Android Studio (GUI, any OS — easiest).** Install Android Studio, then open **SDK Manager → SDK
Tools tab → tick “Android SDK Command-line Tools (latest)” → Apply.** This drops them straight into
the standard SDK where `create-device` looks — nothing else to do.

**B. CLI, no GUI.** Get a `sdkmanager` binary, then install the tools into your SDK:

| OS      | Get `sdkmanager`                                                                                                                         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | `brew install --cask android-commandlinetools`                                                                                           |
| Windows | `scoop install android-clt`                                                                                                              |
| Linux   | Arch: AUR `android-sdk-cmdline-tools-latest` — otherwise use the universal zip below                                                     |
| Any OS  | Download **“Command line tools only”** from [developer.android.com/studio](https://developer.android.com/studio#command-line-tools-only) |

```bash
# SDK root: macOS ~/Library/Android/sdk · Linux ~/Android/Sdk · Windows %LOCALAPPDATA%\Android\Sdk
export ANDROID_HOME="$HOME/Library/Android/sdk"          # adjust per OS
sdkmanager --sdk_root="$ANDROID_HOME" "cmdline-tools;latest"   # lands them inside your SDK
yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses         # accept licenses
```

> **Universal-zip only:** the archive unpacks to a `cmdline-tools/` folder — the final layout **must**
> be `<SDK>/cmdline-tools/latest/bin/…` (rename the extracted folder to `latest`; avoid the
> `cmdline-tools/cmdline-tools` trap). Then run the `--licenses` line above.

Verify with `avdmanager list device` or by re-running `npm run mobile:create-device`.

## Running

Mobile is **opt-in** and runs only via its own script (kept out of the default `npm test`, which
needs no device):

```bash
npm run test:mobile
```

`test:mobile` runs `MOBILE=1 playwright test --project=mobile --workers=1` — serial, single device.

After the run, devices the framework **auto-booted are shut down** (via `globalTeardown`) so emulators
and simulators don't linger. A device you booted yourself is never touched. Keep the auto-booted ones
for faster iterative reruns with `MOBILE_KEEP_DEVICES=1` — they're reused on the next run.

### Running in parallel

Each test already names its device (`test.use({ mobile })`). Add `--workers=N` — a cross-process lock
reserves each device so parallel workers never double-book one, and same-device tests serialize (they
wait, not skip).

```bash
npm run test:mobile -- --workers=3
```

```typescript
test.describe('checkout', () => {
  test.use({ mobile: devices.pixel9 }); // these serialize on pixel9…
});
test.describe('login', () => {
  test.use({ mobile: devices.pixel8 }); // …and run in parallel with the pixel9 tests
});
```

**Real parallelism needs a recent Maestro.** Old Maestro (e.g. 2.0.0) pins its on-device driver to a
fixed port (7001), so concurrent flows collide and hang; the rebuilt driver (**Maestro ≳ 2.6**)
allocates a port per process, so concurrent runs on different devices Just Work — verified on 2.6.1
for both Android and iOS. The framework **auto-detects the version**:

- **Maestro ≳ 2.6** → both Android and iOS parallelize across distinct devices (one slot per AVD /
  simulator — an AVD can't run twice; create more with `npm run mobile:create-device`; a real device
  counts too). Effective concurrency ≈ `min(--workers, distinct devices in play)`.
- **Older Maestro** → all runs **serialize** on a single lock, so `--workers>1` stays safe (no port
  clash / hang) — just no speedup. Upgrade with `brew upgrade mobile-dev-inc/tap/maestro` (the bare
  `maestro` name is a different Homebrew cask) or `curl -Ls https://get.maestro.mobile.dev | bash`.

Override the auto-detection with `MOBILE_PARALLEL=1` (force parallel) or `MOBILE_PARALLEL=0` (force
serialize). No Maestro `--shard-split` — Playwright owns parallelism; teardown shuts down whatever it
booted.

### Choosing the device

Devices live in a typed **catalog** (`mobile/devices.ts`) — the single place device names live —
so specs reference them by name and only known devices are selectable:

```typescript
// mobile/devices.ts
export const devices = {
  pixel7: { platform: 'android', device: 'Pixel_7_API_34' },
  iphone16: { platform: 'ios', device: 'iPhone 16 Pro' },
} as const satisfies Record<string, DeviceSpec>;
```

```typescript
// in a spec
import { devices } from '@mobile/devices';
test.use({ mobile: devices.pixel7 }); // type-checked; auto-boots the AVD if it isn't running
```

- An entry's `device` (AVD name / iOS simulator name or UDID) is **auto-booted** if it isn't already
  running. Omit it (e.g. `{ platform: 'android' }`) to use any booted device of that platform.
- No device booted and none named → the test **skips** (doesn't fail). Auto-booted devices are left
  running and reused across runs.
- No AVD/simulator yet? Run **`npm run mobile:create-device`** with no flags for an interactive
  picker: it lists the device profiles and the system images you can choose — on **Android** pulled
  live from the SDK catalog (`sdkmanager --list`: your installed images plus the newest downloadable
  API levels, installed ones marked "no download"); on **iOS** your installed runtimes and iPhone
  device types (plus **⬇ download** entries) — then creates the device and prints the line to paste
  into the catalog. Skip the prompts with flags:
  `npm run mobile:create-device -- --platform ios --name "My iPhone" --type "iPhone 16 Pro" [--download latest|26.0]`
  (or `--platform android --name Pixel_7_API_34 --api 34`).
  - **iOS** can create from an installed runtime (no download) or download one via `xcodebuild`
    (~7 GB) — pick "Download latest" or "Download a specific version…" in the picker, or pass
    `--download`. Apple exposes no CLI to _list_ downloadable versions, so the "specific version" step
    asks you to type one (e.g. `26.0`). Needs full Xcode (not just Command Line Tools).
  - **Android** downloads the chosen system image only if it isn't already installed (~1 GB; the picker marks which are local).
    Requires the command-line tools — see [Installing the Android command-line tools](#installing-the-android-command-line-tools);
    without them the command exits with an actionable message.
- **Headed vs headless:** the framework boots the device **hidden by default** (`-no-window` on
  Android, no Simulator GUI on iOS). Change the central default with `MOBILE_HEADLESS` in
  `env/environments.json`, or override per test with the `headless` option (which wins) —
  `test.use({ mobile: { ...devices.iphone16, headless: false } })` to watch that test run. `headless`
  **always takes effect, even on a reused device**: iOS just toggles the Simulator app, while an
  Android emulator running in the other mode is restarted (the boot is the trade-off). Scoped to the
  `test.use()` block; other tests are unaffected.
- Env alternatives: `MOBILE_PLATFORM` / `MOBILE_DEVICE` apply when a spec doesn't set the `mobile` option.

## Testing your own app

The examples use built-in apps (Settings) so they run with zero install. To test a **real build**,
point the framework at your artifact — it's installed on the device once before the flow runs, then
the flow `launchApp`s it by `appId`:

```json
// env/environments.json → common (or a specific env)
"MOBILE_APP_ANDROID": "builds/app-debug.apk",           // local path or https URL
"MOBILE_APP_IOS": "builds/App.app"                        // .app, or an https URL to a .zip of it
```

```yaml
# your flow references the app by id
appId: com.example.app
---
- launchApp: { clearState: true } # clearState resets app data → per-test isolation
- tapOn: 'Sign in'
```

Or per test: `test.use({ mobile: { ...devices.pixel9, app: 'builds/app-debug.apk' } })`. The app is
installed **once per run** (serial worker), not before every test. Sources: a **local path** or an
**https URL** (Android APK, or an iOS `.zip` containing the `.app` — handy for CI artifacts).

**Scope:** APK on the Android emulator and `.app` on the iOS simulator are supported today, plus
**real Android devices** (see below). Android **AAB** (needs `bundletool`) and iOS **`.ipa` / real
devices** are not yet wired — see [Not yet (V2)](#not-yet-v2).

### Real devices

- **Android (supported):** plug in a device with USB debugging on, confirm `adb devices` lists it,
  then target it by its serial: `test.use({ mobile: { platform: 'android', device: 'RZ8N...' } })`
  (or `MOBILE_DEVICE=RZ8N...`). A real device is used as-is — never auto-booted or shut down — and
  `adb install -r` puts your APK on it just like the emulator.
- **iOS (not yet):** Maestro supports physical iPhones via its WebDriverAgent driver + a `--team-id`,
  but it needs a signed `.ipa`, install via `xcrun devicectl`, and real-device discovery (`devicectl`,
  not `simctl`) — none of which is wired here yet. It's also currently blocked upstream on Xcode 26.4+
  ([mobile-dev-inc/maestro#3218](https://github.com/mobile-dev-inc/maestro/issues/3218)). Deferred.

## Authoring a test

Two pieces: a **Maestro flow** (the mobile steps, in YAML) and a **spec** that runs it (Playwright).

**1. Write the flow** under `tests/mobile/flows/` (organize by platform folder if you like):

```yaml
# tests/mobile/flows/android/login.yaml
appId: com.example.app
---
- launchApp
- tapOn: 'Sign in'
- inputText: 'user@example.com'
- assertVisible: 'Welcome'
```

**2. Write the spec** — same shape as a UI/API test: pick the device with `test.use`, run the flow:

```typescript
// tests/mobile/login.mobile.ts
import { test } from '@fixtures/mobileFixtures';
import { devices } from '@mobile/devices';

test.describe('Login — Android', () => {
  test.use({ mobile: devices.pixel7 }); // device auto-boots if needed

  test('signs in', async ({ maestro }) => {
    await maestro.run('tests/mobile/flows/android/login.yaml');
  });
});
```

Specs are `*.mobile.ts` (so the `mobile` project picks them up and the browser projects don't). Omit
`device` to use an already-booted device (or `MOBILE_DEVICE`); `platform` falls back to
`MOBILE_PLATFORM`.

## Reporting

`npx playwright show-report` shows the `mobile` project with each flow as a test. Every Maestro command
is replayed as a native **Playwright step**, so the report reads like a normal Playwright test:

- **Step-by-step timeline** — `launchApp "…"`, `tapOn "…"`, `takeScreenshot …`, each with its duration.
- **On failure**, the exact failing step is marked, and its error carries the **real reason** from
  Maestro (e.g. `Element not found: …`), not just an exit code.
- **Attachments** per test: `maestro-junit` (JUnit XML), `maestro-log` (the full run log), and
  screenshots — including the one Maestro auto-captures at the point of failure.

For the deepest detail, the raw artifacts still live in `test-results/<test>/` (`debug/maestro.log`,
`debug/commands-*.json`, `screenshots/`). Pass/fail comes from Maestro's exit code.

## Not yet (V2)

Out of scope for now: retries with device reset, and a fluent TS builder that generates flows
(Playwright-style authoring without hand-written YAML). App install covers APK/`.app`; **AAB** (needs
`bundletool`) and **iOS `.ipa` / real devices** (signing + `devicectl`, and blocked upstream on Xcode
26.4+) are deferred. Already supported: [parallel runs](#running-in-parallel) and step-by-step
[reporting](#reporting).
