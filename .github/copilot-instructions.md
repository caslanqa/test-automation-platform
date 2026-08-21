# Copilot Instructions — Playwright Test Automation Platform (PWTAP)

## Build, Test & Lint

### Commands

- **Full build (solution):** `npm run build` — compiles all packages in dependency order (`platform` → `core-template` → `create` → plugins)
- **Clean build:** `npm run clean && npm run build`
- **Lint:** `npm run lint` (report) or `npm run lint:fix` (auto-fix)
- **Format:** `npm run format` (write) or `npm run format:check` (report only)
- **Type-check:** `tsc --noEmit`
- **Smoke test:** `npm run smoke` — scaffolds a throwaway project, verifies it builds and runs

### Per-package builds

Each package is a TypeScript composite; individual packages rebuild with `tsc -b packages/platform`, etc. The monorepo's `tsconfig.json` is a solution file referencing all publishable packages.

### Testing structure

- **In the platform itself:** `npm test` runs `node --test` over `packages/*/test/**/*.test.ts` — 61 test files across 9 packages. TypeScript is type-stripped at runtime; `scripts/test-hooks.mjs` remaps `./x.js` imports to `./x.ts`. Types are checked separately via `tsconfig.tests.json`.
- **Smoke tests (CI/local):** four, each asserting something a unit test cannot reach —
  - `npm run smoke` — `scripts/smoke-scaffold.mjs`: scaffolds a core-only project and asserts every `pwtap:` marker survives.
  - `npm run smoke:agents` — `scripts/smoke-agents.mjs`: renders the Claude Code agent plugin and asserts capability gating in both directions, plus the one-line stdout contract.
  - `npm run smoke:judge` — `scripts/smoke-judge.mjs`: drives the AI judge's calibration CLI against a local fake gateway, and requires a gate to FIRE on a flipped verdict.
  - `npm run smoke:k6` — the shipped k6 scenario against a local target.
- **Budget gate:** `npm run nfr` (`scripts/nfr-check.mjs`) — dependency footprint, banned direct dependencies, stale `dist/` orphans, published size.

## High-Level Architecture

### Monorepo Layout

```
packages/
├─ platform/         → @pwtap/platform          (published; OS seam for plugins)
├─ core-template/    (private, changeset-ignored; source of truth for scaffolded projects)
│  └─ files/         ← copied verbatim into new projects
├─ create/           → @pwtap/create            (published; CLI scaffolder, bin: create-pwtap)
│  └─ agents/        ← neutral agent/skill/command definitions, rendered per project
├─ mobile-core/      → @pwtap/mobile-core       (published; driver-neutral mobile contracts + adapter registry)
├─ mobile-inspector/ → @pwtap/mobile-inspector  (published; recorder/inspector, bin: mobile-inspect)
├─ plugin-maestro/   → @pwtap/plugin-maestro    (published; mobile via Maestro)
├─ plugin-appium/    → @pwtap/plugin-appium     (published; mobile via Appium/WebdriverIO)
├─ plugin-db/        → @pwtap/plugin-db         (published; Knex SQL + MongoDB)
├─ plugin-perf/      → @pwtap/plugin-perf       (published; in-suite budgets + k6 load)
└─ plugin-ai-judge/  → @pwtap/plugin-ai-judge   (published; LLM-as-judge matchers)
```

### Dependency Order

The root `tsconfig.json` is a solution file listing **nine** project references, in build order:
`platform` → `create` → `plugin-ai-judge` → `mobile-core` → `mobile-inspector` → `plugin-maestro` →
`plugin-appium` → `plugin-db` → `plugin-perf`.

`core-template` is **deliberately absent** from that graph: `files/` is copied verbatim into client
projects and is compiled by each client's own `tsconfig.json`, never by this monorepo. `create`
bundles it at `prepack` (`bundle:template`), so `template/` and `core-manifest.json` are generated
artifacts, not sources.

### Plugin System

Plugins are npm packages that wire into scaffolded projects through **marker-managed regions**:

- **`plugin-apply.ts`** in `create/src/` reads plugin manifests, injects devDeps/scripts/env keys/example tests/Playwright projects via text markers.
- Each plugin exports a `manifest.ts` defining what it adds (scripts, devDeps, env keys, fixture names, example test paths, Playwright project names).
- `playwright.config.ts` in scaffolded projects has two managed regions: **gates** (after `loadEnv()`) and **projects** (inside `projects:[]`); plugins splice their config there.

### Fixture Composition

Scaffolded projects merge fixtures with `mergeTests` / `mergeExpects`:

```ts
// fixtures/index.ts (MANAGED)
import { mergeTests, mergeExpects } from '@playwright/test';
import uiTest from './ui';
import apiTest from './api';
import { aiJudgeFixtures } from '@pwtap/plugin-ai-judge';

export const test = mergeTests(uiTest, apiTest, aiJudgeFixtures.test);
export const expect = mergeExpects(uiTest.expect, apiTest.expect, aiJudgeFixtures.expect);
```

Tests import the barrel: `import { test, expect } from '@fixtures'`.

## Key Conventions

### Commit Messages

Uses `@commitlint/config-conventional` with custom **types** and **scopes**:

- **Types (required):** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`, `ai`
- **Scopes (required):** `core`, `utils`, `config`, `fixtures`, `pages`, `tests`, `ci`, `docs`, `mobile`, `api`, `ui`, `ai`
- **Example:** `feat(core): add session auth caching` or `fix(api): handle 500 errors`
- **Run:** `npm run commit` (commitizen prompt)

### Code Style

- **Prettier:** 100 char line width, trailing commas, single quotes, organized imports (via `prettier-plugin-organize-imports`)
- **ESLint:** TypeScript strict mode, playwright rules, prettier enforcement
- **Monorepo linting:** Project-relative `tsconfig.json` per package; ESLint uses `projectService: true` so it finds the nearest config

### Plugin Markers

Managed regions use comment anchors. The `create` scaffolder injects code between markers; **do not move or rename** these without updating `plugin-apply.ts`:

A region runs from `// pwtap:<key>` to `// pwtap:<key>:end`, and the predicate is a **whole-line**
match (`packages/create/src/util/markers.ts`) — substring matching cannot be used, because the end
marker contains the start marker.

| File in a scaffolded project | Region keys                                           |
| ---------------------------- | ----------------------------------------------------- |
| `fixtures/index.ts`          | `plugins:imports`, `plugins:tests`, `plugins:expects` |
| `playwright.config.ts`       | `plugins:gates`, `plugins:projects`                   |

If a marker is missing, `addToRegion` throws `MarkerError` and the injector returns `false` so the
caller prints a paste block rather than making a half-edit (see `injectors/pwConfig.ts`).

If editing scaffolded template files or plugin injection logic, verify markers stay intact —
`scripts/smoke-scaffold.mjs` asserts every key above.

### Environment Configuration

- `env/environments.json` is **per-environment scalars** (dev, staging, prod, etc.). Each defines `BASE_URL` (UI) and `API_BASE_URL` (API), kept separate to avoid collisions.
- Select environment with `TEST_ENV=staging npm test` (defaults to `common.DEFAULT_TEST_ENV`).
- `config/loadEnv.ts` flattens all env keys to `process.env` at runtime.

### Session-Based Auth

Optional, lazy, and per-scope:

- Declare named users in `testData/users.json` (login credentials + optional account metadata).
- Use via `test.use({ session: 'admin' })` (whole file/describe) or `test.as('admin')(...)` (single test).
- First test to use a session logs in and caches it per worker; subsequent tests reuse it.
- Unauthenticated tests (public pages) set nothing.

### Versioning & Publishing

Uses Changesets + GitHub Actions:

- Add a change: `npm run changeset` (pick affected packages + bump type: patch/minor/major)
- Commits are tracked in `.changeset/*.md` files
- CI publishes from the **Release** workflow (manual `workflow_dispatch`):
  1. With pending changesets, **Release** opens a **Version Packages** PR (bumps versions, writes changelogs)
  2. Merge that PR, trigger **Release** again — publishes to npm + creates GitHub Release
- Core (`@pwtap/core-template`) is private (never published); only `platform`, `create`, and plugins are public.

### TypeScript Path Aliases (Scaffolded Projects Only)

Client projects define aliases for readability. These are **template-relative** and applied to each new project:

- `@api` → `api/`
- `@pages` → `pages/`
- `@config` → `config/`
- `@fixtures` → `fixtures/` (barrel with merged `test` + `expect`)
- `@testData` → `testData/`
- `@utils` → `utils/`

The platform monorepo does **not** use aliases; import relatively.

### Core-Template Isolation

- `packages/core-template/files/` is copied **verbatim** into scaffolded projects. No imports from the monorepo's `packages/*` should leak into template source.
- The template is compiled by **client projects** (each with their own `tsconfig.json`), not by the platform monorepo.
- If updating template code, ensure it's self-contained and doesn't assume monorepo structure.

### Platform Seam (macOS + Linux)

- `@pwtap/platform` abstracts OS-specific operations (paths, shell commands, device discovery/boot).
- Today: macOS (Android + iOS) and Linux (Android). `getPlatform()` throws on any other host with a message
  naming the file to add. A Linux host returns a failed `RunResult` for iOS calls instead of throwing, since
  discovery and the pickers already treat that as "no simulators".
- Plugin code calls `getPlatform()` to access OS operations; never hardcode `darwin` checks.
- **Goal:** hide every OS-specific detail so plugins can be ported to Windows/Linux with only platform-seam changes.

### Plugin Architecture (M4+ scope)

- Plugins are **optional, reversible, and independently published**.
- Each plugin exports `manifest.ts` defining what it adds (scripts, devDeps, env keys, Playwright project, example test).
- Add a plugin: `npx @pwtap/create add @pwtap/plugin-maestro`
- Remove a plugin: `npx @pwtap/create remove @pwtap/plugin-maestro` (undoes all injections; marker-safe)
- Plugins never import scaffolded core (core is copied, plugins are installed); they touch the outside world via `@playwright/test`, `@pwtap/platform`, and `process.env`.

### Node Version

- **Minimum:** Node.js ≥ 22.23
- All packages declare `"engines": { "node": ">=22.23" }` in `package.json`

---

## Quick Reference

| Command                     | Purpose                                  |
| --------------------------- | ---------------------------------------- |
| `npm run build`             | Compile all packages in order            |
| `npm run lint` / `lint:fix` | ESLint check / fix                       |
| `npm run format`            | Prettier write                           |
| `npm run smoke`             | E2E: scaffold + verify markers + build   |
| `npm run smoke:agents`      | E2E: render the agent plugin + gating    |
| `npm run nfr`               | Non-functional budget gate               |
| `npm run commit`            | Conventional commit prompt               |
| `npm run changeset`         | Record a version bump                    |
| `npm run release` (CI only) | Publish to npm                           |
| `tsc -b`                    | Solution build (same as `npm run build`) |
| `npm ls -ws`                | List monorepo workspace structure        |

---

## Why the monorepo structure?

1. **Core is yours.** Scaffolded projects own the UI + API layer outright; no black-box npm package; full editability.
2. **Plugins are packages.** Every engine (mobile, desktop, AI, performance, security) is a separate published npm package; add/remove without lock-in.
3. **One OS seam.** All macOS-specific code lives behind `@pwtap/platform`; plugins stay portable.
4. **Versioning & publishing.** Changesets coordinate multi-package releases and changelogs automatically.
