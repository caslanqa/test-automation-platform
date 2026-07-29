# @pwtap/mobile-inspector

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

### Minor Changes

- a5d8b7a: Replace the fixed frame poll with an adaptive capture schedule, and finish splitting the engine.

  The recorder captured every 1500 ms regardless of anything. On a slow driver that meant overlapping requests
  that saturated the device; on a fast one the screen felt stale; and a driver that cannot produce frames
  cheaply was polled anyway. Capture now happens on connect, after every action, and — only while idle, and
  only when the driver declares `liveFrames` — on an interval of twice the median measured capture time,
  clamped to 750 ms…5 s, doubling per consecutive failure up to 30 s (ADR-006).

  After an action the screen gets a 250 ms settle and, if it moved, a second look a beat later, so an
  animating transition is not recorded as the frame from halfway through it.

  `DeviceSession` now owns the device, the lock and the schedule, which completes the split of the engine into
  the five owners §6 describes; the coordinator is down from 967 lines to 562.

  **Also:** the poll timer is `unref`'d, so a session left connected by a crash can no longer keep the host
  process alive forever.

- 072cc6e: Edit test files through the project's TypeScript compiler instead of by string search (ADR-005).

  Recording into a file found its insertion point with `lastIndexOf('\n});\n')`, which lands in the wrong place
  as soon as the file has a helper, a trailing object literal or a second test — the statement then went
  outside the test body and the generated file did not compile. Appending to an existing file dropped every
  import the target did not already have unless it lacked `@fixtures` entirely.

  Both now parse with the project's own `typescript` (resolved from the project, not bundled — ADR-014): the
  statement goes at the end of the last `test(...)` block, and a merge unions imports by module specifier and
  wraps the appended body in its own `test.describe` so the generated `test.use()` cannot rewrite the target
  file's configuration. Nothing is re-emitted from the AST — the original text is sliced at the positions the
  parser reports, so formatting and comments survive. A project without `typescript` degrades audibly instead
  of silently mangling the file.

- efca711: Split the recording engine into focused modules, and fix undo/redo quietly losing work.

  The engine had grown to 967 lines owning the device, the action log, the source draft, file writing and the
  Playwright child process at once. Four responsibilities now have their own modules — `TestRunner`,
  `TestWriter`, `Recorder`, `Draft` — leaving the coordinator at 656 lines. Behaviour is unchanged except where
  noted; the existing end-to-end tests through the engine are what made the extraction safe.

  **Undo/redo no longer discards work.** The action log was a pair of stacks, and any non-append edit threw the
  redo stack away: undoing a step and then removing an unrelated one made the undone work unrecoverable with no
  indication. It is now a cursor over an append-only log, so undo destroys nothing, and a removal that does
  rewrite the log is deliberate and observable.

  **The draft's writer is explicit.** It is either generated from the action log or owned by the user once they
  type, and a device event is never the writer — which is the rule that keeps pressing Run from emptying the
  editor, since `run` releases the device before it spawns Playwright.

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

- 072cc6e: Make the save dialog browse the project, gate refused actions, and fix the UI's accessibility holes.

  The save dialog asked for a location as free text, so a typo became "cannot read tests" at save time. It now
  lists the project's real directories (`listDirs`), skipping `node_modules`, build output and dotfiles, with
  drill-in and a parent link. Both save and browse resolve through one confinement helper that compares path
  segments and follows symlinks — the previous `startsWith` check let `/proj-evil` pass as inside `/proj`, and
  a symlinked directory read or wrote outside the project (ADR-010).

  The locator menu no longer offers actions the connected driver refuses: each button is disabled with the
  driver's own reason as its tooltip. Only an explicit `false` in the driver's capabilities refuses, so a
  driver that has not listed a kind is not crippled.

  **Accessibility:** the connection drawer was `aria-hidden` while closed, which hid it from screen readers but
  left every control tabbable; it is now `inert`, closes on Escape, and moves focus in on open. The locator
  menu is a labelled dialog whose candidates are a radiogroup with arrow/Home/End navigation, a roving tab
  stop, focus moved in on open and restored on close. The save dialog is a native `<dialog>` opened with
  `showModal()`, which supplies the focus trap, Escape and focus restoration it previously lacked.

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
  - @pwtap/platform@1.0.0

## 0.1.2

### Patch Changes

- 76bd9d8: Harden mobile-inspector/runtime compatibility and raise the Node baseline.

  - `@pwtap/mobile-inspector` now loads platform APIs through a compatibility bridge so outdated
    `@pwtap/platform` installs fail with a clear upgrade error instead of crashing module load on
    missing named exports.
  - Tighten plugin runtime dependency ranges to mobile-inspector/platform versions that include the
    inspector integration fixes.
  - Raise supported Node version to `>=22.23` across the monorepo's publishable packages.

- Updated dependencies [76bd9d8]
  - @pwtap/platform@0.3.2
