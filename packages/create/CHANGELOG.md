# @pwtap/create

## 0.6.1

### Patch Changes

- 9507350: Fix the plugin checkbox duplicating a line when you press space

  The redraw moved the cursor up by the number of plugins, which is the number of physical rows only when no entry
  wraps — and the real entries are 88 to 141 characters, so at 80 columns every one of them wrapped. The rows the
  count missed stayed on screen and the next draw landed underneath them, so a toggle looked like it duplicated the
  line. Measured in a pseudo-terminal: the old renderer asked for `ESC[4A` at both 200 and 80 columns, right at the
  first width and two rows short at the second, which is why this survived until someone used a normal terminal.

  Entries are now truncated to the terminal width, so the list is always one row per plugin and the arithmetic is
  trivially right; the redraw also clears to the end of the screen rather than line by line, so a resize between two
  draws cannot leave a wider row behind. The header hint is two lines, since as one it was 57 characters and wrapped
  on a narrow terminal.

## 0.6.0

### Minor Changes

- 79a5cae: Put each plugin's usage notes into the project's README, and derive the plugin list instead of typing it out.

  Every plugin manifest already declared a `readmeSection` — `ai-judge` wrote a substantial one — and nothing read
  the field. A scaffolded project had no README at all, so the first place a teammate looks to learn what the suite
  can do was empty while four plugins carried the answer. Found by auditing which parts of `plugin-db` were
  declared but never watched run: `ensure` fired correctly, the docs copied, and this did nothing.

  `create-pwtap add` now creates a README when a project has none and gives each plugin its own marked section, so
  adding twice refreshes rather than duplicates and `remove` takes out exactly its own. Markers are HTML comments,
  since a `//` line is body text in Markdown.

  The "Add a plugin later" hint after scaffolding is derived from the registry too. It read
  `<maestro|appium|ai-judge>` — hardcoded, so it silently omitted `db` the day it shipped, and would have omitted
  the next plugin as well.

  `remove` also names the files the plugin installed, not only the ones importing it. Removing `db` broke six
  files and the report named one: the rest imported `knex`/`mongodb`, which left with the plugin, or used a
  fixture that vanished from the barrel while importing only `@fixtures`. The manifest already declares which
  directories a plugin created, so there was nothing to guess.

### Patch Changes

- 6c75130: New plugin: `@pwtap/plugin-db` — database testing across PostgreSQL, MySQL, MariaDB and SQLite (through Knex)
  plus MongoDB, covering query assertions, seed/reset and migration verification.

  Two independent fixture families rather than one universal API, because relational and document models differ
  at the root and a layer over both would leak where you need precision: `db` → `sql` hands over a raw Knex
  instance, `mongoDb` → `mongo` a raw MongoDB `Db`. Four distinct names, so the barrel merges them alongside
  every other plugin.

  Connections are worker-scoped, so one pool serves a worker and Playwright closes it — no teardown project,
  unlike the mobile plugins. A database that is unreachable or unconfigured **skips** the test with the reason
  rather than failing it. SQL migrations are Knex's own system wired up; MongoDB has no equivalent, so the plugin
  ships a small runner (files with `up(db)`/`down(db)`, applied in filename order, tracked in
  `_pwtap_migrations`) instead of taking a third dependency.

  `@pwtap/create` gains the registry entry, which is the part that actually makes `create-pwtap add db` offer it.

  Every SQL dialect is verified against a real engine, not just Postgres: `resetSqlDatabase` emits different SQL
  for each and `discoverTables` reads a different catalog, so "Knex uses one code path" was true of the query
  builder and false of the part this plugin wrote. All four pass, and each skips when its engine is absent.

## 0.5.0

### Minor Changes

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

### Patch Changes

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

## 0.4.2

### Patch Changes

- 76bd9d8: Harden mobile-inspector/runtime compatibility and raise the Node baseline.

  - `@pwtap/mobile-inspector` now loads platform APIs through a compatibility bridge so outdated
    `@pwtap/platform` installs fail with a clear upgrade error instead of crashing module load on
    missing named exports.
  - Tighten plugin runtime dependency ranges to mobile-inspector/platform versions that include the
    inspector integration fixes.
  - Raise supported Node version to `>=22.23` across the monorepo's publishable packages.

## 0.4.1

### Patch Changes

- 5e8e969: Register `@pwtap/plugin-appium` as a stable plugin in the scaffolder menu — mobile testing via Appium: a raw WebdriverIO session (`app: WebdriverIO.Browser`, no curated facade), Android (UiAutomator2) + iOS simulator (XCUITest), macOS-first. Add it with `npx create-pwtap add appium`.

## 0.4.0

### Minor Changes

- e1ce755: Replace the "type comma-separated numbers" plugin picker with an arrow-key checkbox list (↑/↓ move, space toggle, enter confirm). Coming-soon plugins are shown but the cursor skips over them. Non-interactive scaffolds (`-y` or no TTY) are unaffected — they still take `defaultSelected` plugins automatically.

## 0.3.0

### Minor Changes

- cf322df: Collect package.json metadata interactively, npm-init style: the scaffolder now prompts for version, description, author (defaulted from your git identity), keywords, and repository URL (alongside the existing project name and license), and writes them into the generated `package.json`. Empty answers are omitted; `-y` takes the defaults.

## 0.2.0

### Minor Changes

- c495e50: Scaffolder now mirrors the official `npm init playwright` questions: a tests-folder name (renames the folder and repoints the Playwright config `testDir`, the tsconfig `@tests` alias, and the eslint test glob), an optional GitHub Actions workflow, whether to install browsers, and — on Linux — whether to install OS dependencies. TypeScript/JavaScript is intentionally not asked (the platform is TypeScript-only). Adds non-interactive flags `--tests-dir <name>` and `--gha`, and records the chosen folder in `package.json` (`pwtap.testsDir`) so a later `add` copies plugin examples into it.

### Patch Changes

- d508646: Add per-package READMEs (npm landing pages) and rewrite the root README for the monorepo.
- b3e6f9f: Register `@pwtap/plugin-maestro` as a stable plugin in the scaffolder menu — mobile testing via Maestro with two mixable authoring styles (a Playwright-style imperative API and batch YAML flows), Android + iOS simulator, macOS-first. Add it with `npx create-pwtap add maestro`.
- d508646: Rename the scaffolded UI example folder from `tests/example` to `tests/ui` (pairs with `tests/api`).

## 0.1.0

### Minor Changes

- Initial public release of the Playwright Test Automation Platform.

  - `@pwtap/platform` — macOS-first platform seam (paths, shell, device discovery/boot, device lock) for plugins.
  - `@pwtap/create` — UI + API core scaffolder with opt-in plugins (`npm init @pwtap`); bundles the editable core template.
  - `@pwtap/plugin-ai-judge` — LLM-as-judge matchers (`toPassRubric`/`toScoreAtLeast`/`toMatchImage`) with prefix-routed multi-provider support (Ollama, OpenAI-compatible gateways, native Claude) and a `registerProvider` escape hatch.
