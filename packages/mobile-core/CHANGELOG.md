# @pwtap/mobile-core

## 1.2.1

### Patch Changes

- 77f2476: Make the device-unavailable message testable without the machine deciding the branch

  `deviceUnavailableMessage` says something different depending on whether this machine has any devices, and its
  test forced the empty branch by setting `PATH=/nonexistent`. That stubbed nothing: the emulator is invoked by
  absolute path inside the Android SDK, so the branch under test was whichever one the developer's machine produced.
  On a laptop with AVDs the message listed them and the assertions passed; in CI there are none, the other branch
  ran, and every run failed for a week while `npm test` was green locally.

  The device list is an optional injected parameter now, defaulting to real discovery, so both branches are covered
  deterministically — including that the no-devices branch does NOT offer `MOBILE_INSPECTOR_DEVICE`, which would be
  advice that cannot work when there is no device to name.

## 1.2.0

### Minor Changes

- 766def0: Audit the two driver adapters: four defects where the driver-neutral contract was neutral in name only.

  **The same test behaved differently on each driver.** Every action option is optional, and each adapter
  invented its own default for the ones a test omitted — `isVisible` waited 2 s on Maestro and 5 s on Appium,
  `longPress` held 1 s on Appium and whatever Maestro chose. A test written once and run on both, which is the
  entire promise, could pass on one and fail on the other purely on timing. The defaults now live in the
  contract (`ACTION_DEFAULTS` in `@pwtap/mobile-core`) and both adapters resolve from there. `isVisible` stays
  short and `waitFor` gets Playwright's own 5 s, because they are asked different questions.

  **`SwipeOptions.distance` did nothing at all.** Declared in the IR, exposed by the fixture, and read by
  neither adapter — so `swipe('up', { distance: 0.3 })` silently swiped the full screen on both drivers. It is
  now honoured: as `percent` on Appium/Android and as start/end percentage points on Maestro, whose
  direction-only swipe has no distance of its own. XCUITest swipes by direction only, so Appium/iOS refuses a
  requested distance instead of swiping a different amount and calling it done.

  **Maestro discarded `longPress`'s `durationMs`.** Its own `longPressOn` takes the same properties as `tapOn`
  and no duration (confirmed against Maestro's cheat sheet), so a recorded 3-second press was never one. It now
  refuses, the way `scroll` already refused `within`.

  **The capability matrix lied on iOS.** `MobileInspectorDriver.capabilities` is one static answer given before
  a platform is known, so the Appium driver declared `back: true` and then threw `"back" has no iOS equivalent`
  — which left the inspector offering a Back button that always failed and the fixture's support check passing.
  A session may now narrow the declaration for the platform it connected to (`DriverSession.capabilities`,
  optional, so no contract bump), and the fixture and the UI both prefer it.

  Verified on real devices: Appium/iOS reports `back: false` where the driver still declares `true`, a distance
  swipe is honoured on Maestro and Appium/Android and refused on Appium/iOS, and a `longPress` with a duration
  is refused on Maestro rather than quietly held for the wrong time.

- f132819: Never hand back a Maestro session that cannot perform anything.

  Maestro scopes every command — including `tap` and `back` — to one app, and refuses until one is set. The
  adapter only set it when the caller named an app, so connecting with an empty app id produced a session that
  showed the screen, listed the hierarchy, and failed every single interaction with
  `[maestro] call maestro.launchApp(appId) before other commands`: an internal API instruction, surfaced on
  every click, with nothing recorded.

  The driver now resolves an app itself. The foreground app is what the user is looking at, so it is the one
  they mean: `@pwtap/platform` gains `foregroundAndroidApp()`, and the adapter adopts it. When no app can be
  determined it refuses the connection outright, naming what to supply, instead of connecting into a state where
  nothing works.

  Whatever it resolves is reported back on the session (`DriverSession.appId`, optional so adapters that always
  require an explicit id are unaffected) and is what codegen pins — a recording that pinned nothing would launch
  nothing on replay and re-record against whatever happened to be open.

- 15d477d: Settle the deferred decisions, and stop settling the screen after actions that cannot change it.

  **`native` locators: hand-authored only, never ranked.** A native selector is specific to one driver on one
  platform by definition, so emitting one from the recorder would produce a recording that replays only under the
  driver that made it — the opposite of the premise the whole IR rests on. `MobileLocator.native` stays as the
  escape hatch for what the IR cannot express, and both adapters pass it through untouched.
  `LocatorCandidate.strategy` no longer lists `native`: the engine never produced it, and a type promising a case
  that cannot happen forces dead branches on every consumer.

  **Frame re-encoding: not needed.** Measured at ~150 KB per capture against a 2 MB budget.

  **A read-only action no longer settles the screen.** Every successful action paid a settle — a sleep, a
  hierarchy re-read and up to two captures — including `assertVisible`, `assertNotVisible`, `isVisible` and
  `screenshot`, none of which can change what is on screen. Since commands run one at a time, that was also delay
  in front of whatever the user did next.

  **A run announced as finished had not necessarily cleaned up.** The temp file's removal was fired off unawaited
  and `runStatus: finished` was emitted immediately, so a client told the run had ended could still see the file —
  the opposite of what §11 promises. It is awaited now. This had been showing up as a test that failed only under
  load, three times across one session; it was a real ordering bug wearing a flaky test's clothes.

  Two options were measured and declined rather than left vague, both recorded in §14 with their numbers:
  capturing frames through `adb` instead of the driver (181 → 130 ms, but a second Android-only capture path in
  the layer that has already produced two field defects, for ~8 % of click→screen), and driving Maestro's own
  daemon the way Studio does (~420 ms per tap, but an interface Maestro neither documents nor exposes a port
  flag for, so we would own every break — while Appium is one option away at 194 ms).

- 452ced5: Say which device was missing and which ones exist, and let a pinned device be redirected without editing the
  test.

  A recording pins a device by name so it is reproducible (ADR-003), which means the first thing that happens on
  a colleague's laptop or in CI is that the name does not resolve. Both adapters answered
  `no android device available to connect the inspector to`: it named neither the device asked for nor the ones
  present, said nothing about how to proceed, and mentioned the inspector during a plain test run. It now reads

  > [maestro] android device "pixel42" was not found on this machine. Available: pixel9 (booted), galaxy21,
  > pixel10, pixel11, pixel8, pixel9b. Point `mobileTarget.device` at one of those, override it with
  > MOBILE_INSPECTOR_DEVICE=<name>, or create it in Android Studio > Device Manager, or `avdmanager create avd`.

  with the list deduplicated by name and capped, since a machine can carry forty simulators and six of them can
  be called "iPhone 17 Pro". Naming no device at all is reported as the different problem it is, rather than
  quoting `"undefined"` back.

  `MOBILE_INSPECTOR_DEVICE` is new, and closes an asymmetry: `driver`, `platform` and `headless` could all be
  redirected from the environment and `device` — the one value that is machine-specific by nature — could not.
  It is the one option where the environment WINS over the test, deliberately: which driver and platform are
  under test is the test's own meaning and an environment must not quietly change it, whereas a device name is a
  fact about one machine, and the alternative to an override is editing every recorded test per machine.

  **Also:** the inspector's app-id field now says what it is for. It reads as "the only app I may touch", which
  left a journey that starts on the home screen looking impossible; it is neither a restriction nor optional. It
  is what the recorded test launches, and Maestro requires one for every command — the app's own scope does not
  limit which elements a command may act on, verified on a device by recording home → app drawer → tap the icon →
  tap inside the app, all in one session.

### Patch Changes

- bb09e7d: Fix the two defects reported from a real installation: taps that never became code, and a generated test
  that could not find its device.

  **A reloaded page recorded nothing.** The command envelope's sequence guard was scoped to the launch while a
  browser counts from 1 on every page load, so after a reload every command came back `409 command 1 arrived
after 5`. Frames need no command, so the device screen kept updating and the UI looked perfectly alive while
  each click was silently refused — on both drivers and both platforms, because the defect is in the transport.
  `seq` is now reset on attach: ordering only ever needed to hold within one client's own stream of POSTs.

  **The generated test pinned the adb serial.** The device picker sends the serial, which is the only handle
  that addresses a live emulator, and two things then failed to turn it back into the durable AVD name:
  `findBootedAndroid` wrote the caller's own input (or the serial) into `DiscoveredDevice.name`, a field
  documented as the AVD name, and `resolveStableDeviceName` never consulted the device list it is handed —
  where the serial→AVD mapping was sitting all along. A recording therefore produced
  `device: "emulator-5554"`, which fails with `no android device available to connect the inspector to` once
  that emulator instance is gone. Both are fixed, and the same recording now pins `pixel9` and replays.

  **A second view is no longer refused.** `mobile-inspect` opens a window _and_ prints the URL, so opening
  that URL — which the README invites — got a 409, and an `EventSource` that receives a non-200 never retries:
  the page rendered and stayed deaf. The newest view now takes over, the displaced one is told and closes its
  own stream (a server-side close would read as a retryable drop and the two would displace each other
  forever), and either can take it back.

  **A refused action is now stated on screen.** An action the driver rejects is deliberately not recorded, but
  the reason lived only in a log tab the user had to know to open, so a click that produced nothing looked like
  a bug in the recorder. It now says which action was refused and why.

  **And a test layer that would have caught all of it.** The suite had no UI row: the service tests speak the
  protocol correctly by construction and the engine tests never load a page, so the seam where both defects
  lived was untested. Four tests now drive the real page in a real browser against the fake driver — reload
  keeps recording, the picker's serial still becomes an AVD name in codegen, a refused action is stated on
  screen, and a second view takes over instead of going deaf. Each was checked against the unfixed code first;
  the AVD-name one fails with exactly the `device: "emulator-5554"` seen in the field. CI installs Chromium so
  they cannot silently skip.

- Updated dependencies [f132819]
- Updated dependencies [bb09e7d]
  - @pwtap/platform@1.1.0

## 1.1.0

### Minor Changes

- d2dff69: Three recording fixes, each verified against a real emulator.

  **Tree selection survives a hierarchy read.** Every read builds a fresh object graph, and the accessibility
  tree compared nodes with `===`, so a selected element silently deselected itself on the next poll while the
  device panel kept highlighting stale bounds. Nodes now carry `path` and `key` (`assignNodeIdentity`), and the
  UI remembers the key and re-resolves it each render.

  **Maestro honours a recorded scroll direction.** The adapter called Maestro's bare `scroll()`, which only
  ever scrolls down, so the direction the user recorded was discarded; it now issues a directional swipe.
  `scroll` with `within` is refused with a clear message rather than silently scrolling the whole screen and
  producing a test that merely looks like it scrolls a container.

  **A locator from another app is flagged, not ranked highly.** A whole-screen hierarchy includes other apps'
  elements, and tapping one can succeed while the replay fails, because a driver is scoped to an app id. Such
  a node now loses 60 points and carries an explicit warning. Detection is partial by platform: Appium Android
  reports the owning package per node, while Maestro's payload has no package field at all — see §7 of
  `docs/mobile-inspector/architecture.md`.

  **Also:** the Maestro adapter was dropping `cls`, `enabled` and `val` from every node, which left the whole
  hierarchy unlabelled in the tree (91 nodes on a real screen, 0 with a class name) and weakened the new
  identity key. `val` now folds into `text`, matching how the Appium adapter already folds iOS `value`.

- 42562d6: Replace the platform compatibility shim with a declared core↔adapter contract, and validate `appSource`.

  `platformCompat.ts` imported `@pwtap/platform` as a namespace and probed each function at load time, so an
  outdated install failed with an upgrade message instead of a module-resolution crash. That treated a
  versioning problem as a runtime problem for the wrong pair of packages: `@pwtap/platform` is a direct
  dependency with a caret range, so npm already resolves a version that has the exports. The shim is deleted.

  The pair that genuinely can disagree is core and adapter, because an adapter is resolved from the client
  project's own `node_modules`. `@pwtap/mobile-core` now exports `MOBILE_CORE_CONTRACT` and
  `MIN_ADAPTER_CONTRACT`, each adapter declares the contract it was built against as a literal
  (`export const contract: AdapterContract = 1`), and discovery skips an adapter it cannot accept while
  reporting which package to upgrade — the inspector logs it, and `DriverNotFoundError` carries it so "no
  driver found" is never the whole story when the adapter is installed but unloadable. One bad adapter does
  not disable the others. The `AdapterContract` type is the exact current value, so bumping the contract
  breaks each adapter's build until someone confirms it still satisfies the new one.

  **`appSource` (ADR-010):** the artifact path comes from a browser field and ends at `adb install` /
  `simctl install` / Appium's `app` capability, so it is now validated before an adapter sees it — an existing
  local `.apk`/`.ipa`/`.zip` file or `.app` bundle directory, or an `https:` URL. Other schemes are refused,
  including `http:`. The adapter receives an absolute path so it never has to guess the base directory, while
  the generated test keeps the path as typed: an absolute one would only work on the machine that recorded it.

### Patch Changes

- 42562d6: Add the missing READMEs, and enforce the dependency budget in CI.

  Neither `@pwtap/mobile-core` nor `@pwtap/mobile-inspector` had a README — the two newest packages in the
  workspace were the two with no published documentation.

  `npm run nfr` now checks the §11 budget rows that are deterministic: no `electron` anywhere in the runtime
  packages' transitive graph, no `ws`/`prettier`/`typescript` as our own direct dependency (a third-party
  client bringing its own WebSocket implementation is its business), the inspector's published artifacts all
  present, and its unpacked size within 5 MB. CI also builds the inspector's UI bundle now, which nothing did
  before — a vite failure would have surfaced at publish time.

  A device-gated workflow (`device.yml`, nightly plus manual dispatch) runs the record → generate → save flow
  across Android × {Maestro, Appium} and iOS × {Maestro, Appium}, with a 10-minute per-test timeout because
  the 30 s default is sized for the fake driver.

- 4235259: Fix three defects found by packaging the product and installing it into a clean project.

  **Stale build output shipped.** `tsc -b` emits but never prunes, so a moved or deleted source leaves its
  `.js`/`.d.ts`/`.map` in `dist` forever. `@pwtap/mobile-inspector` was publishing eleven orphans, including
  the three `dist/electron/*` modules ADR-001 removed — dead code importing a package that is not a
  dependency — and `@pwtap/mobile-core` shipped the deleted `platformCompat`. Every publishable package now
  cleans its output before building (`npm run clean`), and `npm run nfr` fails on any `dist` file with no
  matching source.

  **Ctrl-C during launch crashed the CLI.** Launching the browser takes a second or two. A signal in that
  window left `newPage()`/`goto()` to reject unhandled: the CLI died with a stack trace and exit 1 before
  `service.close()` could release the device lock or delete its temp files — precisely the teardown ADR-011
  requires — and a signal arriving even earlier killed the process outright, since the handlers were not yet
  installed. The handlers now go in before the service starts, the window launcher hands back a closable
  handle the moment the browser exists (so a signal mid-launch cannot orphan a Chromium), and a navigation
  failure is reported rather than thrown.

  **`remove` left a project that would not compile.** Removing a plugin unwires its fixture, Playwright
  project, env keys and package, but deliberately leaves the example tests it installed — a user may have
  built their suite on them. Silence was the wrong middle ground: `tsc` and `playwright test` both failed on
  imports of a package that was gone, with nothing explaining it. The files still stay; `remove` now names
  them and says why.

  Verified by installing every package from a local tarball into a freshly scaffolded project — no workspace
  links, no registry: both mobile plugins wire in with the shared `mobileApp` fixture injected exactly once,
  generated `*.maestro.ts`/`*.appium.ts` tests type-check and are collected by their own gated project and no
  other, and `mobile-inspect` serves the UI, refuses an untokenised request and exits 0 on a signal.
