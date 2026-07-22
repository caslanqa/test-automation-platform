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

- **In the platform itself:** No runtime tests yet (M0–M3 scope is foundation only). Tests live in scaffolded client projects.
- **Smoke test (CI/local):** `scripts/smoke-scaffold.mjs` runs the full scaffolder pipeline, verifies output compiles and passes a basic Playwright run.

## High-Level Architecture

### Monorepo Layout

```
packages/
├─ platform/        → @pwtap/platform (published; OS seam for plugins)
├─ core-template/   (private; source of truth for scaffolded project)
│  └─ files/        ← copied verbatim into new projects
├─ create/          → @pwtap/create (published; CLI scaffolder)
└─ plugin-ai-judge/ → @pwtap/plugin-ai-judge (published; LLM-as-judge matchers)
```

### Dependency Order

- `platform` (macOS seam for paths, shell, device discovery/boot, device lock)
- `core-template` (private; UI + API source that gets copied)
- `create` (scaffolder CLI that bundles core-template + reads plugin manifests)
- Plugins (published packages that depend on `@playwright/test` + `@pwtap/platform`)

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

- `// @pwtap-marker: FIXTURES_IMPORT` — plugin fixture imports
- `// @pwtap-marker: FIXTURES_MERGE` — fixture merging calls
- `// @pwtap-marker: PLAYWRIGHT_GATE` — env gates in `playwright.config.ts`
- `// @pwtap-marker: PLAYWRIGHT_PROJECTS` — Playwright project definitions

If editing scaffolded template files or plugin injection logic, verify markers stay intact.

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

### Platform Seam (macOS-First)

- `@pwtap/platform` abstracts OS-specific operations (paths, shell commands, device discovery/boot).
- Today: macOS only. Calling any platform function on non-darwin **throws** with a message naming the file to add.
- Plugin code calls `getPlatform()` to access OS operations; never hardcode `darwin` checks.
- **Goal:** hide every OS-specific detail so plugins can be ported to Windows/Linux with only platform-seam changes.

### Plugin Architecture (M4+ scope)

- Plugins are **optional, reversible, and independently published**.
- Each plugin exports `manifest.ts` defining what it adds (scripts, devDeps, env keys, Playwright project, example test).
- Add a plugin: `npx create-pwtap add @pwtap/plugin-maestro`
- Remove a plugin: `npx create-pwtap remove @pwtap/plugin-maestro` (undoes all injections; marker-safe)
- Plugins never import scaffolded core (core is copied, plugins are installed); they touch the outside world via `@playwright/test`, `@pwtap/platform`, and `process.env`.

### Node Version

- **Minimum:** Node.js ≥ 20.19
- All packages declare `"engines": { "node": ">=20.19" }` in `package.json`

---

## Quick Reference

| Command                     | Purpose                                  |
| --------------------------- | ---------------------------------------- |
| `npm run build`             | Compile all packages in order            |
| `npm run lint` / `lint:fix` | ESLint check / fix                       |
| `npm run format`            | Prettier write                           |
| `npm run smoke`             | E2E: scaffold + verify build + test      |
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
