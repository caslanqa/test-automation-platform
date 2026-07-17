# Mobile Testing (Maestro)

Mobile tests run on [Maestro](https://maestro.mobile.dev) but are orchestrated by Playwright:
**Playwright is the runner/reporter, Maestro is the mobile execution engine** (invoked as a CLI — no
npm dependency). It's the fourth engine alongside web, API, and the AI Judge. You author in either of
two styles, mixable in one test:

- **Imperative (TypeScript)** — `await maestro.tapOn('Login')`, one call per step, Playwright-style.
  Branch in TypeScript on the live screen with `isVisible` / `inspectScreen`. See
  [Authoring imperatively](#authoring-imperatively-typescript).
- **YAML flows** — hand-written [Maestro flows](#authoring-with-a-yaml-flow) run via `maestro.run('<flow>.yaml')`.

> In a hurry? The [Mobile Cheat Sheet](MOBILE_CHEATSHEET.md) has the day-to-day commands — listing
> device/app IDs, booting/installing, and the Maestro CLI.

## How it fits together

```text
tests/mobile/*.mobile.ts        Playwright specs: test.use({ mobile }) + the `maestro` fixture
        │
        ├─ imperative:  await maestro.tapOn('Login')      ─┐
        └─ YAML batch:  maestro.run('flows/login.yaml')    │
                                                           │
mobile/core/MaestroMcpSession.ts  imperative → 1 command per call over a warm `maestro mcp` driver
mobile/core/McpClient.ts          stdio JSON-RPC 2.0 client for that `maestro mcp` process
mobile/core/MaestroRunner.ts      YAML batch → spawns `maestro --device <id> test <flow> …`
mobile/core/DeviceManager.ts      finds (or boots) a device (adb / xcrun simctl)
```

- **Layer 1 — `MaestroMcpSession`** (`mobile/core/`): the imperative path. Holds one long-lived
  `maestro mcp` process per device (spawned lazily on the first command) and sends each call as a
  single Maestro command over MCP. The device driver stays **warm** between calls, so `await` has
  true per-command semantics and no per-command process spawn — and you can branch in TypeScript on
  the live screen.
- **Layer 1 — `MaestroRunner`**: the YAML batch path. Runs one whole flow file on a device via the
  Maestro CLI and reports the exit code + artifact locations.
- **Layer 1 — `DeviceManager`**: finds a booted device for the platform — or, when you name one
  (`MOBILE_DEVICE` / `test.use({ mobile: { device } })`), **boots it and waits** until it's ready.
- **The specs** (`tests/mobile/*.mobile.ts`): read just like the UI and API tests —
  `test.use({ mobile: { platform, device } })` selects the device, then the `maestro` fixture drives
  it (imperative methods and/or `maestro.run('<flow>.yaml')`). The fixture reports each command as a
  Playwright step and attaches screenshots + Maestro artifacts.

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

`test:mobile` runs `MOBILE=1 playwright test --project=mobile --workers=3` — up to 3 workers, with a
per-device lock so tests on distinct devices run in parallel and same-device tests serialize (see
[Running in parallel](#running-in-parallel)). With a single device it effectively runs serially.

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

Specs are `*.mobile.ts` (so the `mobile` project picks them up and the browser projects don't). Pick
the device with `test.use` (omit `device` to use an already-booted one / `MOBILE_DEVICE`; `platform`
falls back to `MOBILE_PLATFORM`), then drive it with the `maestro` fixture — imperatively, with a
YAML flow, or both in one test.

### Authoring imperatively (TypeScript)

Call the commands as methods; each runs one Maestro command against the warm device driver and shows
up as its own report step. `launchApp` first (element commands need the app id).

```typescript
// tests/mobile/login.mobile.ts
import { test } from '@fixtures/mobileFixtures';
import { devices } from '@mobile/devices';

test.describe('Login — Android', () => {
  test.use({ mobile: devices.pixel7 }); // device auto-boots if needed

  test('signs in', async ({ maestro }) => {
    await maestro.launchApp('com.example.app', { clearState: true });
    await maestro.tapOn('Sign in');
    await maestro.inputText('user@example.com');

    // Branch on the live screen — impossible in a static YAML flow. Never throws; returns a boolean.
    if (await maestro.isVisible('Cookie banner')) {
      await maestro.tapOn('Accept');
    }

    await maestro.assertVisible('Welcome');
    await maestro.takeScreenshot('after-login');
  });
});
```

Selectors are a plain string (matched as Maestro `text`) or a selector object
(`{ id: 'submit' }`, `{ text: 'OK', index: 1 }`, position matchers like `below` / `rightOf`).

| Method                                        | Maestro command | Notes                                              |
| --------------------------------------------- | --------------- | -------------------------------------------------- |
| `launchApp(appId, { clearState?, stopApp? })` | `launchApp`     | Call first; sets the target app for later commands |
| `tapOn` / `doubleTapOn` / `longPressOn`       | tap variants    | Takes a selector                                   |
| `inputText(text)` / `eraseText(n?)`           | text entry      | Types into / clears the focused field              |
| `assertVisible` / `assertNotVisible`          | assertions      | Fail the step if the condition isn't met           |
| `scroll()` / `scrollUntilVisible(sel, {…})`   | scrolling       | `scrollUntilVisible` stops when the element shows  |
| `swipe({ direction \| start,end })`           | `swipe`         | Direction (`UP`…) or two `x%,y%` points            |
| `back()` / `pressKey(key)` / `hideKeyboard()` | keys            | System back / hardware key / dismiss keyboard      |
| `waitForAnimationToEnd()`                     | wait            | Settle animations before asserting                 |
| `takeScreenshot(name)`                        | screenshot      | Captured and attached to the report as `<name>`    |
| `isVisible(sel, { timeout? })` → `boolean`    | (query)         | For branching — never fails; waits ≤ 2000 ms       |
| `inspectScreen()` → hierarchy                 | (query)         | Live view tree for richer TypeScript branching     |

Under the hood the imperative path talks to a `maestro mcp` server over stdio, keeping the device
driver warm across calls — so `await maestro.tapOn(...)` executes and fails at that exact line, with
no per-command process spawn. The process is spawned on the first imperative call and torn down when
the test releases the device, so batch-only tests never pay for it.

### Authoring with a YAML flow

Prefer a hand-written flow (e.g. sharing it with a Maestro-only workflow, or a long static script)?
Write it under `tests/mobile/flows/` and run it with `maestro.run(...)`:

```yaml
# tests/mobile/flows/android/login.yaml
appId: com.example.app
---
- launchApp
- tapOn: 'Sign in'
- inputText: 'user@example.com'
- assertVisible: 'Welcome'
```

```typescript
test('signs in', async ({ maestro }) => {
  await maestro.run('tests/mobile/flows/android/login.yaml');
});
```

## Reporting

`npx playwright show-report` shows the `mobile` project with each test made of native **Playwright
steps** (one per Maestro command), so it reads like a normal Playwright test:

- **Step-by-step timeline** — `launchApp "…"`, `tapOn "…"`, `assertVisible "…"`, each with its duration.
- **On failure**, the exact failing step is marked with the **real reason** from Maestro (e.g.
  `Element not found: …`), not just an exit code — and the framework auto-captures the **real device
  screen + view hierarchy at that point**, attached under the failing step (`failure.jpg`,
  `failure-hierarchy.json`). This is the native-mobile equivalent of Playwright's on-failure screenshot.
- **Batch (`maestro.run`) attachments**: also `maestro-junit` (JUnit XML), `maestro-log` (full run
  log), and any `takeScreenshot` images.

### Screenshots & trace

Native mobile has no browser for Playwright to trace, so a `page`-based trace/video/network capture
is impossible — instead the framework attaches real **device** evidence, controlled by
`MOBILE_SCREENSHOT`:

- `only-on-failure` (default) — capture the screen + hierarchy only at a failure. Fast.
- `on` — also capture after **every** command → a step-by-step visual timeline you can scrub in both
  the HTML report and the **trace viewer** (each step carries its screenshot). Costs one screenshot
  per command. Set it inline: `MOBILE_SCREENSHOT=on npm run test:mobile`.
- `off` — no captures.

The mobile project disables Playwright's own `video`/`screenshot` (always empty for a native device)
and keeps `trace` (retain-on-failure) — which now carries the above step captures. For the deepest
detail, batch-run raw artifacts still live in `test-results/<test>/` (`debug/maestro.log`,
`debug/commands-*.json`). Network capture is not available for native flows (would need a device
proxy — out of scope).

## AI-judging a screen

The framework's multimodal **AI Judge** (see [AI_JUDGE.md](AI_JUDGE.md)) evaluates the _same_ mobile
screenshots — judge a native screen against a plain-English rubric, exactly as you would a web page.
`maestro.takeScreenshot(name)` returns the file path, which `expectAi` accepts as its `image`:

```typescript
import { expectAi } from '@fixtures/aiExpect';
import { test } from '@fixtures/mobileFixtures';
import { devices } from '@mobile/devices';

test.use({ mobile: devices.iphone16 });

test('the checkout screen looks right', async ({ maestro }) => {
  await maestro.launchApp('com.example.app');
  await maestro.tapOn('Checkout');

  const shot = await maestro.takeScreenshot('checkout');
  await expectAi({
    image: shot, // a file path; a Buffer or data URI also work
    rubric: 'A checkout screen with an order total, a payment method, and a visible Pay button.',
  }).toPassRubric({ minScore: 80 });
});
```

Compare-against-a-reference works too: `expectAi({ image: shot }).toMatchImage('baseline/checkout.png')`.
Running it needs an AI provider configured (an Ollama vision model at `JUDGE_OLLAMA_BASE_URL`, or an
OpenAI key) — same setup as the web AI-judge examples. A ready, provider-gated example ships at
`tests/mobile/ai-judge.mobile.ts` (it **skips** cleanly when no vision-capable provider is available,
so it never breaks a run without one).

Every `expectAi` assertion records the verdict in the report as an **"AI judgement — pass/fail (score N)"**
step — on **both** pass and fail — with the full reasoning + model attached. So a failed AI check is
explainable straight from the report (`npx playwright show-report`), not just the terminal error.

## Not yet (V2)

Out of scope for now: retries with device reset. App install covers APK/`.app`; **AAB** (needs
`bundletool`) and **iOS `.ipa` / real devices** (signing + `devicectl`, and blocked upstream on Xcode
26.4+) are deferred. Already supported: the [imperative TypeScript API](#authoring-imperatively-typescript)
(Playwright-style authoring, no hand-written YAML), [parallel runs](#running-in-parallel), and
step-by-step [reporting](#reporting).
