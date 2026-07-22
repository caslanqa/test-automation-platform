# Playwright Test Automation Platform (@pwtap) — Greenfield Monorepo

## Context

The current repo (`@caslanqa/create-playwright-ai`, v4.0.1) is a **single-package** Playwright scaffolder that copies its own source tree into a new project (`bin/create-project.cjs`). Mobile (Maestro), desktop (Electron), and AI-Judge engines were bolted on as opt-in "modules" inside that one package. The result is hard to version, hard to publish independently, and couples every engine's OS-specific code into the scaffolder.

**Goal:** restructure into an **npm-workspaces monorepo** where **UI + API is the copied-in core** and every engine (Maestro, Appium, AI-Judge, k6, desktop, security) is an independently **published npm plugin** wired in through a typed **manifest**. Develop **macOS-first**; hide every OS-specific command behind a single `@pwtap/platform` seam so other OSes are additive later. The existing Maestro engine and the core API/UI/auth code are salvaged; new plugins are built fresh.

### What exploration changed vs. the draft (grounded in the actual clone)

- **No new repo, no remote, single branch.** This is a seed clone with only `refactor/clean-structure` and no `origin`. The monorepo will be built **in-place on a new branch** (the only option in this environment), moving salvaged code into `packages/*` and removing the old single-package layout.
- **`feat/native-desktop-app-testing` branch and `native/` sources do not exist here.** There is **zero Appium/webdriverio code** anywhere in the clone (`grep` for `appium|webdriverio|NativeSession` returns nothing). `plugin-appium` is therefore **fully greenfield** — modeled on the `ElectronSession` hooks/lifecycle shape (`desktop/core/ElectronSession.ts`) and the Maestro fixture shape, not ported from a native branch.
- **`fixtures/globalFixtures.ts` is present and compiles** (the draft's "deleted → doesn't build" motivation is not literally true in this checkout). It's the session/auth `test` object; it becomes core `fixtures/ui.ts`.
- **There is no merged fixture barrel today.** `fixtures/index.ts` only re-exports `globalFixtures`; each engine fixture (`apiFixtures.ts`, `mobileFixtures.ts`) is a separate `base.extend`, and tests import them **directly** (`@fixtures/mobileFixtures`). The `mergeTests`/`mergeExpects` barrel is genuinely **new** work, and example tests must be rewritten to import from it.
- **The AI-judge matcher is named `expectAi`** (`fixtures/aiExpect.ts`, `baseExpect.extend`), not `aiExpect`. Keep the export name `expectAi`.

### Scope of THIS increment (first PR)

The full draft is M0–M8. That is far too large for one reviewable PR. **This PR delivers the Foundation, M0–M3:** the workspace, `@pwtap/platform`, `core-template`, and `@pwtap/create` producing a **working core-only scaffolder** (chromium + api). Plugins (Maestro M4, Appium M5, stubs M7) are sequenced as **follow-on PRs** — the plan below defines their seams so this PR does not paint them into a corner. Publishing (M8) is a dry-run at the end of this PR; real `npm publish` waits until plugins land.

## Architecture at a glance

```
                         @pwtap/create  (published CLI: `npm init @pwtap`)
                                │  reads
          ┌─────────────────────┼──────────────────────────┐
          ▼                     ▼                           ▼
   registry.ts             core-template/            plugin manifest.ts
   KNOWN_PLUGINS   (private, bundled via prepack)    (published w/ each plugin)
   (pre-install menu)   files/ copied VERBATIM       devDeps/scripts/env/fixture/
                        into client project           project/examples/ensure
                                │                           │
                                ▼                           ▼ injectors (marker-anchored)
                        client project ──────────────────────────────┐
                        fixtures/index.ts (MANAGED barrel)            │
                        mergeTests(uiTest, apiTest, <plugin tests>)   │
                        mergeExpects(uiExpect, <plugin expects>)      │
                        playwright.config.ts (MANAGED gates+projects) │
                                                                      │
   @pwtap/platform  ◄── runtime dep of every plugin ─────────────────┘
   (macOS command/path seam; device discover/boot; deviceLock)
```

**Dependency order for the build:** `platform` → `core-template` → `create` → (later) plugins. Plugins never import core (core is copied, plugins are installed); they touch the outside world only through `@playwright/test` (peer), `@pwtap/platform`, and `process.env`.

## Target monorepo layout

```
repo root  (private, npm workspaces, engines.node ">=20.19")
├─ package.json                # { private:true, workspaces:["packages/*"] }
├─ tsconfig.base.json          # strict opts salvaged from current tsconfig.json
├─ tsconfig.json              # solution file: "references" to each package
├─ eslint.config.js .prettierrc .commitlintrc.json .husky/   # salvaged from root
├─ .changeset/                 # coordinated versioning + publish
├─ .github/workflows/{ci,release}.yml
├─ scripts/smoke-scaffold.mjs  # e2e: run CLI into temp dir → tsc + playwright test
└─ packages/
   ├─ platform/       → @pwtap/platform     (PUBLISHED; plugins' runtime dep)
   ├─ core-template/  (PRIVATE, NOT published; single source of truth for scaffold input)
   │   ├─ manifest.ts
   │   └─ files/      # copied VERBATIM into client project
   ├─ create/         → @pwtap/create        (PUBLISHED; scaffolder)
   ├─ plugin-maestro/ → @pwtap/plugin-maestro (PUBLISHED; M4 — salvages current mobile/)
   ├─ plugin-appium/  → @pwtap/plugin-appium  (PUBLISHED; M5 — fully NEW)
   └─ plugin-{ai-judge,k6,desktop,security}/  (stubs; M7)
```

## This PR — files & steps

### M0 · Workspace foundation
- Root `package.json`: `{ "private": true, "workspaces": ["packages/*"], "engines": { "node": ">=20.19" } }`. Move dev tooling (eslint/prettier/husky/commitlint/typescript) here as root devDeps.
- `tsconfig.base.json`: salvage `compilerOptions` from the current `tsconfig.json` (strict set) minus the client path aliases. `tsconfig.json` becomes a solution file with `references` to each package.
- Salvage `eslint.config.js`, `.prettierrc`, `.commitlintrc.json`, `.husky/` to root.
- Init Changesets; add `.github/workflows/ci.yml` (install, `tsc -b`, lint, run `scripts/smoke-scaffold.mjs`).
- **Verify:** single lockfile at root; `npm ls -ws` resolves; `tsc -b` green on empty packages.

### M1 · @pwtap/platform (published)
`packages/platform/src/{index.ts, types.ts, macos.ts, device/{discover,lock,android,ios}.ts}`
- Define `Platform` interface + `getPlatform()` factory; only `MacPlatform` today; `getPlatform` **throws** on non-darwin with a message naming the file to add.
- Salvage macOS paths/commands out of `mobile/core/android.ts` (the `darwin` branch of `androidSdkRoot`, `adbPath`/`sdkTool`, `androidEnv`, `listAvds`, `bootAndroidAvd`, `shutdownEmulator`) and **all** of `mobile/core/ios.ts` (already 100% macOS: `xcrun simctl`, `open -a Simulator`, `osascript … quit`). Drop the `win32`/`linux` branches — they do not move.
- Move `mobile/core/deviceLock.ts` **verbatim** (already OS-agnostic: `os.tmpdir()` + atomic `mkdir`); this is the shared `deviceLock` Maestro and Appium will both use.
- `Platform` surface: `os`, `androidSdkRoot()`, `adbPath()`, `emulatorPath()`, `androidEnv()`, `simctl(args)`, `openSimulatorApp()`, `quitSimulatorApp()`, `which(cmd)`, `homedir()`, `run(cmd,args,opts)`.
- **Verify (Mac):** `getPlatform().os === 'macos'`; `adbPath()` resolves under `~/Library/Android/sdk`; `simctl(['list','devices','-j'])` returns JSON; sim boot+quit works. On CI/Linux the package still type-checks; runtime device calls are Mac-only.

### M2 · core-template (private, not published)
`packages/core-template/files/` — copied verbatim into every scaffold:
- `api/` (salvage `api/core/ApiClient.ts`, `api/core/types.ts`, `api/services/PetService.ts`, `api/models/pet.ts`, `api/index.ts`).
- `pages/` (salvage `pages/{BasePage,LoginPage,index}.ts`).
- `config/` (salvage `config/{loadEnv,envUtils,index}.ts`).
- `fixtures/`:
  - `ui.ts` ← salvage `fixtures/globalFixtures.ts` (the `session`/auth `test` + `expect`) plus `fixtures/auth.ts` helpers.
  - `api.ts` ← salvage `fixtures/apiFixtures.ts`.
  - `index.ts` = **MANAGED barrel** (see below) — the only new-authored fixture file.
- `tests/example/{login.spec.ts, authSession.spec.ts}`, `tests/api/pet.api.ts` — salvage, but **rewrite imports** to pull `test`/`expect` from `@fixtures` (the barrel) instead of the per-file fixtures they use today.
- `env/environments.example.json`, `testData/users.example.json` (salvage).
- `playwright.config.ts` — salvage the current one, strip the mobile/desktop blocks, add the two **MANAGED regions** (gates after `loadEnv()`, project spreads inside `projects:[]`).
- `tsconfig.json` — client path aliases (`@api`, `@pages`, `@config`, `@fixtures`, …).
- `eslint.config.js`, `.prettierrc`, `templates/gitignore`.
- `manifest.ts` — core's own manifest (base scripts + devDeps derived like `createPackageJson` does today).
- **Verify:** copy `files/` to a throwaway dir, `npm i`, `tsc --noEmit` green, chromium `login.spec.ts` + `pet.api.ts` run.

### M2.5 · The managed barrel & config (new authored contract)
`core-template/files/fixtures/index.ts`:
```ts
import { mergeExpects, mergeTests } from '@playwright/test';
import { test as uiTest, expect as uiExpect } from './ui';
import { test as apiTest } from './api';

// pwtap:plugins:imports
// pwtap:plugins:imports:end

export const test = mergeTests(uiTest, apiTest,
  // pwtap:plugins:tests
  // pwtap:plugins:tests:end
);
export const expect = mergeExpects(uiExpect,
  // pwtap:plugins:expects
  // pwtap:plugins:expects:end
);
```
- Because `ui.ts`/`api.ts` are both `base.extend` off the **same** `@playwright/test`, `mergeTests` is valid. The invariant `@playwright/test` = one copy is enforced by making it a **peer dep** in every plugin + relying on npm dedupe; option-fixture names must be unique (`session`, `mobile`, `appium`).
- `add <plugin>` inserts, between the markers: an `import { test as <alias> } from '<pkg>'` line, the alias into `mergeTests`, and (if the plugin exports a matcher) the expect alias into `mergeExpects`. `expectAi` from `plugin-ai-judge` reaches `mergeExpects` this way. `remove` reverses it. If a marker is missing, the injector **prints the block to paste and warns** — never a half-edit.
- `playwright.config.ts` gets the same two-marker treatment for gates + project spreads; each plugin's project is env-gated (`MAESTRO=1`/`APPIUM=1`) so bare `npm test` stays chromium+api.

### M3 · @pwtap/create (published scaffolder)
`packages/create/src/{index.ts, registry.ts, manifest.ts, prompts.ts, commands/{create,add,remove}.ts, injectors/{packageJson,envJson,fixturesBarrel,pwConfig,tests,docs}.ts, util/{fs,log,run,markers}.ts}`
- **Salvage the proven logic** from `bin/create-project.cjs`: `mergeJson`, `sortObj`, `deleteKeys`, `run` (strips `npm_*` env), `flagPresent` (argv + `npm_config_*`), `commandExists`, the readline prompter, the empty-dir guard, husky/git-init, and the marker-anchored `patchPlaywrightConfig` half-edit-safety pattern. Port to TS/ESM.
- `registry.ts` = `KNOWN_PLUGINS: KnownPlugin[]` (pre-install menu; `id, package, category, description, flag, defaultSelected, status?`). Seed with maestro, appium, ai-judge(coming-soon) so the menu renders even before those packages publish.
- `manifest.ts` = `PluginManifest` type (`devDependencies, scripts, envKeys, fixture?, playwrightProject?, examples?, docs?, readmeSection?, ensure?`); authoritative manifest loaded **post-install** via `require.resolve('<pkg>/manifest', { paths: [clientDir] })`.
- `create` flow: guard dir → copy `template/` verbatim (+ `templates/gitignore`→`.gitignore`) → TTY menu from `KNOWN_PLUGINS` (`coming-soon` disabled) → build base `package.json` → install base + selected plugin packages → load each manifest → run injectors in fixed order → final `npm install`, `npx playwright install chromium`, run each `ensure` (advisory, never throws).
- `add`/`remove`: re-run / reverse the install+inject steps; idempotent (skip already-present; injectors marker-anchored).
- **prepack bundling (no drift):** `create/package.json` `prepack` copies `../core-template/files` → `create/template/`; `files: ["dist","template"]`. `core-template` stays private so it never leaks as a runtime dep.
- **Verify:** `smoke-scaffold.mjs` runs `create /tmp/pwtap-smoke -y` (no plugins) → `tsc --noEmit` + `playwright test` (chromium+api) pass; managed markers intact; `npm pack -w @pwtap/create` tarball contains `dist/` + `template/` and no `core-template` dep.

### M8 (this PR, dry-run only) · Publish rehearsal
- Changesets version bump; `npm publish --dry-run -w @pwtap/platform -w @pwtap/create`.
- `npm pack` content assertions: `platform` ships `dist/`; `create` ships `dist/` + `template/`; `access:"public"` set (scoped packages 402/403 otherwise). Real publish deferred to the plugin PRs.

## Follow-on PRs (seams defined here, engines built later)

- **M4 · @pwtap/plugin-maestro** (salvage-heavy): move `mobile/core/{MaestroRunner,MaestroMcpSession,McpClient,session,screen,appInstaller,maestroReport,maestroError,types}.ts`, `mobile/{devices,teardown}.ts`, `create-device.mjs`, and `fixtures/mobileFixtures.ts` → the package. Rewrite its `@mobile/*` and `@config/*` imports: device/boot/lock calls go through `@pwtap/platform`; env comes from `process.env` (client's copied `loadEnv` sets it). `@playwright/test` → peer. Ship `manifest.ts` (`test:maestro` script, `maestroTest` fixture alias, `MAESTRO=1` gate + `maestro` project, `globalTeardown`, `ensure` → java17/adb/maestro). Env namespace `MOBILE_*`. Android boot = seam-boot (parity with Appium).
- **M5 · @pwtap/plugin-appium** (fully NEW — no salvage): `caps.ts` (iOS XCUITest / Android UiAutomator2), `appiumServer.ts` (poll `/status`, spawn local `appium` bin, per-worker cache, `xcuitest` gated to darwin), `AppiumSession.ts` (webdriverio via widened dynamic-import with `peerDependenciesMeta.webdriverio.optional`; imperative surface modeled on `ElectronSession`/`MaestroMcpSession`), `fixture.ts` (`appium` option, `app` fixture, skip-not-fail when device/driver/server absent), `manifest.ts` (`appium^3`, `webdriverio^9`, `APPIUM=1` gate, `appiumTest` alias, `ensure` → driver install). Env namespace `APPIUM_*`. Shares `deviceLock` with Maestro via `@pwtap/platform` to prevent double-boot.
- **M6 · Coexistence:** `add` both into one project; barrel merges `maestroTest`+`appiumTest`; `npm test` stays chromium+api; `test:maestro`/`test:appium` run their own projects; `remove` cleanly reverts.
- **M7 · Stubs:** `plugin-ai-judge` (salvage `utils/ai/*`, `fixtures/aiExpect.ts` → `expectAi`; proves the `mergeExpects` path end-to-end), `plugin-k6`, `plugin-desktop` (salvage `desktop/`), `plugin-security`; add to `KNOWN_PLUGINS` as `coming-soon`.

## Salvage map (verified present in this clone)
- **core-template:** `api/core/{ApiClient,types}.ts`, `api/services/PetService.ts`, `api/models/pet.ts`, `api/index.ts`; `fixtures/{globalFixtures,auth,apiFixtures}.ts`; `pages/{BasePage,LoginPage,index}.ts`; `config/{loadEnv,envUtils,index}.ts`; `playwright.config.ts`; `tsconfig.json`; `env/environments.example.json`; `testData/users.example.json`.
- **@pwtap/platform:** `mobile/core/{android,ios,deviceLock}.ts` (macOS branches only); `mobile/core/appInstaller.ts`, `mobile/core/DeviceManager.ts`, `mobile/core/session.ts` (device-discovery pieces).
- **plugin-maestro:** `mobile/core/{MaestroRunner,MaestroMcpSession,McpClient,screen,maestroReport,maestroError,types}.ts`, `mobile/{devices,teardown}.ts`, `fixtures/mobileFixtures.ts`, `mobile/create-device.mjs`.
- **plugin-ai-judge:** `utils/ai/*`, `utils/aiJudge.ts`, `fixtures/aiExpect.ts`, `config/aiJudge.config.ts`.
- **plugin-desktop:** `desktop/*` (`core/ElectronSession.ts`, `apps.ts`, `example-app/`).
- **CLI blueprint:** `bin/create-project.cjs` (`MODULES` registry → manifests; `addModules` → `add` command; `patchPlaywrightConfig` → marker injectors).
- **NOT present (build fresh):** any Appium/webdriverio/`native/` code; `feat/native-desktop-app-testing` branch.

## Risks
- **`@pwtap` org + scoped access:** scoped packages need `publishConfig.access:"public"`; org must exist. Mitigated by dry-run-only publish this PR.
- **`mergeTests` single-instance rule:** all merged `test` objects must share one `@playwright/test`. Enforced via peer dep + npm dedupe; verified by the smoke scaffold's `tsc` + run.
- **Marker tampering:** if a user deletes a managed marker, `add`/`remove` prints the paste block and warns (salvaged `patchPlaywrightConfig` behavior) — no half-edits.
- **Example-test import rewrite:** salvaged example tests currently import per-file fixtures; they must be repointed at the `@fixtures` barrel or `tsc` breaks. Covered in M2.
- **prepack drift:** `core-template` is private; `create` bundles it at pack time; CI asserts tarball contents.

## Verification (end-to-end for this PR)
1. `tsc -b` green across the workspace on macOS and Linux CI.
2. `node scripts/smoke-scaffold.mjs`: run `@pwtap/create` into a temp dir (no plugins) → `npm i` → `tsc --noEmit` → `playwright test` runs chromium + api; assert the two managed markers exist and are balanced in the generated `fixtures/index.ts` and `playwright.config.ts`.
3. `npm pack -w @pwtap/platform -w @pwtap/create` + assert tarball contents (`create` has `template/`, no `core-template` dep; both `access:"public"`).
4. `npm publish --dry-run` for `platform` then `create`.