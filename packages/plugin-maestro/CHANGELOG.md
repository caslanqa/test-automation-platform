# @pwtap/plugin-maestro

## 2.0.2

### Patch Changes

- 798c95e: Say why a test was skipped in the terminal, not only in the report

  A skipped test showed a dash and its name — no reason — so an unreachable database or an absent device looked
  like an unexplained gap in the run. The reason was never missing: `testInfo.skip(condition, description)` records
  it as a `skip` annotation, which the HTML and JSON reports read and **no terminal reporter prints**. The reason is
  now printed beside the skip as well, and still recorded for the report.

  Two things the live run through the packed tarballs then exposed, both about the reason itself rather than where
  it goes: an uninstalled driver was reported as Knex's `Cannot find module 'pg'` plus a six-line require stack,
  naming no fix, and is now `the pg driver is not installed — run \`npm i -D pg\``; and the console line is held to
  one line whatever a driver decides to say, with the whole text still in the report.

  Running the installed example against a real project then found three more, all in the same family — an option
  that is EMPTY rather than absent, which is exactly what `create` writes into `env/environments.json` for a user to
  fill in:

  - The scaffolded example used `process.env.DB_CLIENT ?? 'pg'`. `??` falls back only on null/undefined, so the
    default never fired in the one case it existed for: an empty key reached Knex as a missing one and the reason
    read `could not create a  connection` — a sentence with a hole in it. Every template now uses `||`.
  - `createSqlConnection` validates its own options instead of relaying Knex's `Required configuration option
'client' is missing`: an empty client, an unknown one (`postgresql` is the likely spelling) and an empty
    connection each name the thing to set.
  - **An unconfigured MongoDB failed the test instead of skipping it.** `new MongoClient('')` throws a
    MongoParseError and was constructed outside the try, bypassing the return-a-reason contract entirely. Measured
    as `1 failed` on a scaffolded project. Both keys are now checked, and the constructor moved inside the try so a
    malformed URI is a reason like any other.

  Finally, the fixtures read the DB_* and MONGO_* env keys themselves, which is what `openSqlConnection` had been
  claiming in its own skip message all along without any code behind it. The scaffolded example did the reading, in
  its module scope, and a user hit the consequence: `no pg connection configured` while the connection string sat
  filled in inside `env/environments.json`. A module's top level is evaluated at a moment that depends on how the
  run was launched, so the read could happen before the config's `loadEnv()` reached it; a fixture body cannot. The
  example sets no option now, and an option that is set wins, with anything it omits falling back to the env.

  The README and `docs/DB_TESTING.md` are rewritten around what a reader actually does, in order: install the driver
  for your engine, configure the env keys, write the check inside the test that caused it, run it, keep tests
  independent under parallelism, migrate and seed, then read the results — including what each of the four scaffolded
  reporters records for a skip, and a table of every measured skip message with the fix. Both had also gone stale:
  each still showed the `test.use({ db: { client, connection } })` pattern this release removes.

## 2.0.1

### Patch Changes

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

- Updated dependencies [766def0]
- Updated dependencies [f132819]
- Updated dependencies [15d477d]
- Updated dependencies [452ced5]
- Updated dependencies [bb09e7d]
  - @pwtap/mobile-core@1.2.0
  - @pwtap/platform@1.1.0

## 2.0.0

### Major Changes

- eb8214e: Make the Mobile Inspector produce tests that actually run.

  Recording, saving and replaying a mobile flow never worked end to end: the generated test imported a
  fixture nobody wired into the `@fixtures` barrel, omitted the `platform` and `appId` needed to connect,
  pinned an `adb` serial that dies on reboot, ran under the browser project, and asserted visibility through
  an action that could only ever throw. This closes that loop, verified on real Android emulators and iOS
  simulators with both drivers. See `docs/mobile-inspector/architecture.md` for the full design and the
  decision record.

  ### Breaking — `@pwtap/mobile-inspector`
  - The driver/device selection option is now **`mobileTarget`** and the facade fixture is **`mobileApp`**
    (previously `mobile` and `app`). Both old names collided with fixtures the mobile plugins already own —
    `@pwtap/plugin-maestro` owns the `mobile` option and `@pwtap/plugin-appium` owns the `app` fixture — and
    in Playwright an option _is_ a fixture, so the collision was a merge conflict rather than an override.
    `mobileTarget` also gains `appId` and `appSource`, which are now forwarded to the driver instead of
    being dropped.

    ```diff
    - test.use({ mobile: { driver: 'appium', device: 'emulator-5554' } });
    - test('flow', async ({ app }) => { await app.tap({ accessibilityId: 'login' }); });
    + test.use({ mobileTarget: { driver: 'appium', platform: 'android', device: 'Pixel_7_API_34', appId: 'com.example.app' } });
    + test('flow', async ({ mobileApp }) => { await mobileApp.tap({ accessibilityId: 'login' }); });
    ```

  - `MobileApp.isVisible()` now resolves `false` when the element is absent instead of throwing. It is
    backed by a new `isVisible` action in the driver-neutral IR; previously it routed through
    `assertVisible`, which throws on absence, so every generated "assert not visible" failed. Generated code
    now emits `await expect.poll(() => mobileApp.isVisible(...)).toBe(...)`.
  - `MobileInspectorDriver` requires a `testBinding` (`{ extension, project, gateEnv }`). A driver now
    declares where its tests live and how they run, so adding a driver needs no changes inside the inspector.
  - The trust boundary validates an action's fields, not just its `kind`. Payloads like a `fill` with no
    `value` or a `swipe` with an invented `direction` are rejected instead of reaching an adapter.

  ### Breaking — `@pwtap/plugin-maestro`
  - The `maestro` Playwright project now matches **`*.maestro.ts`** instead of `*.mobile.ts`, so a file's
    extension names the driver that runs it for hand-written and recorded tests alike. Existing tests need a
    rename; nothing inside them changes.

    ```bash
    git ls-files 'tests/**/*.mobile.ts' | while read -r f; do
      git mv "$f" "${f%.mobile.ts}.maestro.ts"
    done
    npx create-pwtap add maestro   # re-injects the narrowed project block
    ```

  ### `@pwtap/plugin-appium`
  - Fixed an iOS text locator that could never resolve: node text is read from `label` **or** `value`, but
    the selector only matched `label`, so a locator recorded from a `value`-only element failed with
    "element wasn't found" the first time it replayed.
  - Selector values are now escaped, so UI text containing `"` or `\` no longer breaks the predicate.
  - Implements the new `isVisible` action without throwing on absence.

  ### `@pwtap/create`
  - `PluginManifest.fixture` accepts an array, letting a plugin contribute more than one fixture. Both mobile
    plugins now also contribute the shared `mobileApp` fixture, injected once and — importantly — left in
    place when only one of them is uninstalled.
  - Fixed `hasRegion`, which matched markers as substrings. Because `// pwtap:x:end` contains `// pwtap:x`, a
    file that had lost only its start marker looked intact and then crashed with an unhandled `MarkerError`
    instead of reporting the problem. This affected all four injectors.

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

- d434c7f: Take Electron out of the mobile stack, and split the runtime contracts away from the recorder.

  Installing a mobile plugin used to drag ~306 MB into a project that might never open the recorder: Electron
  (296 MB), a second copy of Prettier (9.6 MB) and a WebSocket library, all reachable because the plugins
  depended on the recording _application_ to get at a handful of types. That is now ≈0. Phase 1 of
  `docs/mobile-inspector/architecture.md`; the recorder itself keeps working, hosted in a browser window
  instead of an Electron shell.

  ### New — `@pwtap/mobile-core`

  The driver-neutral contracts a _test_ actually loads: the action IR and types, the locator engine, device
  discovery, the `./inspector` adapter registry, and the `mobileApp` fixture. Its only dependency is
  `@pwtap/platform`. Both mobile plugins now depend on this instead of on `@pwtap/mobile-inspector`, which the
  adapters had only ever used for types plus three pure helpers.

  ### Breaking — `@pwtap/mobile-inspector`
  - **Now a development tool, injected as a `devDependency`** by the mobile plugins' manifests rather than
    pulled in as a runtime dependency. It is not in the path of a test run.
  - **The runtime surface moved to `@pwtap/mobile-core`.** Type-only re-exports remain for one minor, so
    existing type imports get a deprecation rather than a build error; the runtime values (the `test`/`expect`
    fixture, the locator helpers) are deliberately not re-exported, because a test importing them from here
    would be loading a dev tool at runtime.
  - **Electron is gone.** `mobile-inspect` now starts a loopback service and opens it in an app-mode Chromium
    window using the browser Playwright already installed — the same way Playwright's own Inspector, UI mode
    and Trace Viewer are hosted. With no browser downloaded it prints the URL and says
    `npx playwright install chromium`. The `start` and `inspect:electron` scripts and the duplicate
    `bin/inspect-electron.mjs` launcher are removed.
  - **The transport is SSE + POST instead of WebSocket**, so `ws` is gone too: events stream from
    `GET /events`, commands go to `POST /command` with a monotonic sequence number, and frame _bytes_ are
    fetched from `GET /frame/<id>` rather than base64-encoded into an event. Reload safety comes with it —
    `EventSource` reconnects on its own, and the recording session now belongs to the service launch rather
    than to the connection, so pressing F5 mid-recording keeps the device session, the timeline and the draft.
  - **Prettier is resolved from the project** instead of bundled, so a saved test is formatted by the user's
    own version and `.prettierrc`. A project without Prettier gets an unformatted file and a log line.
  - **One inspector per project.** A second launch is refused with the URL of the first; a lock left behind by
    a crash is reclaimed rather than treated as a conflict.

  ### Fixed
  - A recorded interaction is no longer discarded because its frame id moved on. The frame id is advisory: the
    hierarchy is re-read at action time anyway, so a tap acts on the current screen instead of being dropped
    with only a warning — which is what made clicks "randomly do nothing" while the frame poll was running.
  - Disconnecting a device no longer clears the editor. The draft and timeline describe work the user did and
    survive both a disconnect and the disconnect that `run` performs before it spawns Playwright.
  - The UI's log and run-output buffers are bounded, so a long session (or a device failing on every poll) can
    no longer grow without limit.

  ### `@pwtap/create`

  Both mobile plugin manifests now contribute the shared `mobileApp` fixture from `@pwtap/mobile-core` and
  inject `@pwtap/mobile-inspector` as a devDependency.

### Patch Changes

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

- Updated dependencies [d2dff69]
- Updated dependencies [42562d6]
- Updated dependencies [42562d6]
- Updated dependencies [4235259]
  - @pwtap/mobile-core@1.1.0

## 1.0.0

### Major Changes

- 5f96d85: mobile inspector issue fix

### Patch Changes

- Updated dependencies [5f96d85]
  - @pwtap/mobile-inspector@1.0.0
  - @pwtap/platform@1.0.0

## 0.3.3

### Patch Changes

- 76bd9d8: Harden mobile-inspector/runtime compatibility and raise the Node baseline.

  - `@pwtap/mobile-inspector` now loads platform APIs through a compatibility bridge so outdated
    `@pwtap/platform` installs fail with a clear upgrade error instead of crashing module load on
    missing named exports.
  - Tighten plugin runtime dependency ranges to mobile-inspector/platform versions that include the
    inspector integration fixes.
  - Raise supported Node version to `>=22.23` across the monorepo's publishable packages.

- Updated dependencies [76bd9d8]
  - @pwtap/mobile-inspector@0.1.2
  - @pwtap/platform@0.3.2

## 0.3.1

### Patch Changes

- Updated dependencies [5e8e969]
  - @pwtap/platform@0.3.0

## 0.3.0

### Minor Changes

- c6df135: Add two whole-test evidence capture features, both best-effort (never fail or mask the real test result):

  - `MOBILE_DEVICE_LOG=1` attaches the device's own OS system log (Android `logcat`, iOS the unified system log) as `device-log`. Off by default.
  - Screen recording is **not** a mobile-specific setting — the `maestro` fixture reads Playwright's own built-in `video` option (`use.video` in `playwright.config.ts`), so one central setting governs recording for chromium and maestro alike, honoring all seven of Playwright's video modes (`off`/`on`/`retain-on-failure`/`on-first-retry`/`on-all-retries`/`retain-on-first-failure`/`retain-on-failure-and-retries`, each checked against `testInfo.retry`). Attaches as `maestro-recording`.

- c12d624: Every replayed step now attaches Maestro's real, unedited data for that exact command as `maestro-step-log` — not a synthesized summary. Imperative commands attach the YAML sent over MCP plus Maestro's raw response text; batch YAML steps attach the exact JSON entry Maestro recorded (command + metadata) from `debug/commands-*.json`. A failing step always attaches its log; on a passing step it's opt-in via the new `MOBILE_STEP_LOGS=1` env key, so passing runs stay quiet by default. Also exports `resolveVerboseStepLogs` alongside `resolveScreenshotMode` for bespoke wiring.
- c6df135: ⚠️ Breaking: removed `MOBILE_SCREENSHOT`. Screenshot capture is no longer a mobile-specific setting — the `maestro` fixture now reads Playwright's own built-in `screenshot` option (`use.screenshot` in `playwright.config.ts`, or a project/describe override), the same one `chromium`/`page` tests already use, so one central setting governs both. All four of Playwright's screenshot modes are honored (`off`/`on`/`only-on-failure`/`on-first-failure`, the last collapsing to `only-on-failure` on the first attempt and `off` on any retry). Anyone relying on `MOBILE_SCREENSHOT` should set `use.screenshot` in `playwright.config.ts` instead — the scaffolded template already sets `screenshot: 'only-on-failure'` there, matching the previous default.

  `MaestroMcpSession`'s constructor also changed shape: the trailing positional `screenshotMode`/`binary`/`verboseLogs` parameters are now a single `MaestroSessionOptions` object (`new MaestroMcpSession(device, hooks, { screenshotMode, binary, verboseLogs })`), for anyone constructing it directly for bespoke wiring.

### Patch Changes

- Updated dependencies [c6df135]
  - @pwtap/platform@0.2.0

## 0.2.0

### Minor Changes

- e052a8e: Run mobile tests in parallel (the device pool) and auto-close framework-booted devices. The `maestro` project is now `fullyParallel`, and each test reserves its device with a cross-process lock keyed `<platform>:<device>` — tests on the same device serialize (wait, not skip), while different devices/platforms run concurrently with `--workers=N` (Maestro ≳ 2.6, or `MOBILE_PARALLEL=1`). A `maestro-teardown` project now runs after the suite and shuts down the emulators/simulators the framework auto-booted this run — headed or headless — so they don't linger; set `MOBILE_KEEP_DEVICES=1` to keep them.

### Patch Changes

- cc51ac0: Fix the Maestro binary resolving to an empty string when the injected `MAESTRO_BIN` env key is left blank. The code used `process.env.MAESTRO_BIN ?? 'maestro'`, but `??` doesn't fall back on `''`, so runs spawned an empty command (`spawn '' EACCES` / "file cannot be empty"). Use `|| 'maestro'` so a blank value falls back to the `maestro` binary on PATH.
- Updated dependencies [d508646]
  - @pwtap/platform@0.1.1
