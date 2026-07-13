# Mobile Testing (Maestro)

Mobile tests are authored as [Maestro](https://maestro.mobile.dev) YAML flows and orchestrated by
Playwright: **Playwright is the runner/reporter, Maestro is the mobile execution engine** (invoked as
a CLI — no npm dependency). It's the fourth engine alongside web, API, and the AI Judge.

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
  - **Android:** an emulator (AVD), created in Android Studio. The Android SDK is auto-detected from
    `ANDROID_HOME` / `ANDROID_SDK_ROOT` / the default location (`~/Library/Android/sdk` on macOS), so
    you usually don't need to export anything.
  - **iOS (macOS):** an available Xcode simulator.

## Running

Mobile is **opt-in** and runs only via its own script (kept out of the default `npm test`, which
needs no device):

```bash
npm run test:mobile
```

`test:mobile` runs `MOBILE=1 playwright test --project=mobile --workers=1` — serial, single device.

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
- No AVD/simulator yet? Create one from your installed SDK/Xcode, then add it to the catalog:
  `npm run mobile:create-device -- --platform ios --name "iPhone 16 Pro"` (or `--platform android --name Pixel_7_API_34`).
- Env alternatives: `MOBILE_PLATFORM` / `MOBILE_DEVICE` apply when a spec doesn't set the `mobile` option.

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

`npx playwright show-report` shows the `mobile` project with one test per flow. Pass/fail comes from
Maestro's exit code; each test has the **Maestro JUnit report and screenshots** attached. Note: the
per-step Maestro timeline is not surfaced in Playwright's trace (Maestro executes as its own process)
— the attached artifacts are the debugging surface.

## Not yet (V2)

Device pools + parallel workers, app install, retries with device reset, auto-shutdown of
framework-booted devices, and JUnit-parsed per-step reporting are intentionally out of the MVP.
