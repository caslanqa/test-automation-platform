# @pwtap/mobile-core

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
