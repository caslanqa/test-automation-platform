# Playwright Test Automation Platform

An **editable UI + API testing core** you scaffold into your project with one command, plus an ecosystem of **opt-in, separately-published plugins** (AI Judge today; mobile, performance, desktop, and security engines planned). macOS-first — other operating systems are additive behind a single platform seam.

[![@pwtap/create](https://img.shields.io/npm/v/@pwtap/create?label=%40pwtap%2Fcreate)](https://www.npmjs.com/package/@pwtap/create)
[![license](https://img.shields.io/npm/l/@pwtap/create)](LICENSE)
[![node](https://img.shields.io/node/v/@pwtap/create)](https://nodejs.org)

## Table of contents

- [Overview](#overview)
- [Requirements](#requirements)
- [Quickstart](#quickstart)
- [Packages](#packages)
- [The core](#the-core)
- [Authentication](#authentication)
- [Plugins](#plugins)
- [AI Judge](#ai-judge)
- [Project structure](#project-structure)
- [CLI reference](#cli-reference)
- [Configuration](#configuration)
- [Scripts](#scripts)
- [Development](#development)
- [Releasing and publishing](#releasing-and-publishing)
- [Roadmap](#roadmap)
- [License](#license)

## Overview

`npm init @pwtap` scaffolds a ready-to-run Playwright project whose **core is copied in as editable source** — you own the UI and API layers outright, rather than importing them from `node_modules`. Every testing engine beyond UI + API (AI Judge, mobile, and so on) is a **real npm package** you opt into; a typed manifest wires each one into your project and out again, reversibly.

Three ideas hold it together:

- **Core is yours.** The scaffolder copies the UI + API framework into your repo. Edit it freely.
- **Plugins are packages.** `add` / `remove` inject fixtures, env keys, an example spec, and a Playwright project through marker-managed regions — no lock-in, fully undoable.
- **One seam for the OS.** All platform-specific work (device discovery, boot, locking) lives behind [`@pwtap/platform`](packages/platform), so engines stay portable.

## Requirements

- **Node.js ≥ 20.19**
- **macOS-first.** UI + API work everywhere Node runs; the mobile/desktop engines target macOS today. Other OSes throw a clear "add this file" error rather than misbehaving silently.

## Quickstart

```bash
npm init @pwtap@latest my-tests        # scaffold the UI + API core (npm create @pwtap@latest also works)
cd my-tests
cp env/environments.example.json env/environments.json   # point BASE_URL / API_BASE_URL at your app
cp testData/users.example.json   testData/users.json      # named login sessions (optional)
npm test                                                   # runs the chromium + api projects
```

Add an engine whenever you need it:

```bash
npx create-pwtap add ai-judge          # installs @pwtap/plugin-ai-judge and wires it in
```

## Packages

This repository is an npm-workspaces monorepo.

| Package                                                                | Role                                                                                        | Published  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------- |
| [`@pwtap/create`](packages/create)                                     | The scaffolder — `npm init @pwtap`. Copies the editable core in and wires plugins.          | ✅         |
| [`@pwtap/platform`](packages/platform)                                 | macOS-first platform seam (paths, shell, device discovery/boot, lock) used by plugins.      | ✅         |
| [`@pwtap/plugin-ai-judge`](packages/plugin-ai-judge)                   | LLM-as-judge matchers (`toPassRubric` / `toScoreAtLeast` / `toMatchImage`), multi-provider. | ✅         |
| `@pwtap/core-template`                                                 | The editable core source that `@pwtap/create` bundles. Private — never published.           | —          |
| `@pwtap/plugin-maestro` · `-appium` · `-k6` · `-desktop` · `-security` | Mobile / performance / desktop / security engines.                                          | 🚧 planned |

## The core

The scaffolded project ships with:

- **UI testing** — Chromium via the `chromium` project, with a Page Object Model (`pages/BasePage.ts`, `pages/LoginPage.ts`).
- **API testing** — a layered client in a browser-free `api` project: `api/core/ApiClient.ts` (typed verbs) → `api/services/*` (business operations) → `tests/api/*.api.ts` (readable tests). The example targets [Petstore v3](https://petstore3.swagger.io).
- **Lazy session auth** — named sessions log in once and cache per worker (see [Authentication](#authentication)).
- **One fixtures barrel** — `fixtures/index.ts` composes `ui` + `api` (and any plugin) with `mergeTests` / `mergeExpects`, exported as `@fixtures`. Import everything from there:

```ts
import { test, expect } from '@fixtures';
```

- **Tooling** — ESLint, Prettier, husky + lint-staged, and commitlint, all pre-wired (the scaffolder runs `git init` so the hooks activate).

## Authentication

Session-based, opt-in, and lazy. Declare named sessions in `testData/users.json`; the first test that uses one logs in and caches it, and everything afterward reuses it. Choose the scope you need:

```ts
import { test, expect } from '@fixtures';

// Whole file or describe:
test.use({ session: 'admin' });
test('dashboard is visible', async ({ page }) => {
  await page.goto('/dashboard'); // already signed in as admin
});

// A single test:
test.as('customer')('can check out', async ({ page }) => {
  /* signed in as customer, just here */
});

// Test-level annotations compose too:
test.as('admin').skip('WIP', async () => {}); // .skip / .only / .fixme / .fail
```

Unauthenticated tests (public pages) simply set nothing.

## Plugins

Plugins are opt-in npm packages wired through a typed manifest. Add or remove them any time:

```bash
npx create-pwtap add ai-judge          # install + wire (fixtures, env keys, example spec, project)
npx create-pwtap remove ai-judge       # cleanly undo
```

| Plugin           | Package                  | Status         |
| ---------------- | ------------------------ | -------------- |
| AI Judge         | `@pwtap/plugin-ai-judge` | ✅ stable      |
| Maestro (mobile) | `@pwtap/plugin-maestro`  | 🚧 coming soon |
| Appium (mobile)  | `@pwtap/plugin-appium`   | 🚧 coming soon |

Each plugin registers an env-gated Playwright project, so a bare `npm test` always stays UI + API only. You can also preselect at scaffold time with a flag, e.g. `npm init @pwtap@latest my-tests --ai-judge`.

## AI Judge

[`@pwtap/plugin-ai-judge`](packages/plugin-ai-judge) adds LLM-as-judge matchers to `expect`:

```ts
import { test, expect } from '@fixtures';

test('bot states the opening hours', async () => {
  await expect({
    userMessage: 'What time do you open?',
    botResponse: 'We open at 9am every day.',
    rubric: 'Must state the store opens at 9am.',
  }).toPassRubric({ minScore: 80 });
});
```

Pick a model with `JUDGE_MODEL` (plus its API key) in `env/environments.json` → `common`. The model id's **prefix** routes it: `anthropic/` (native Claude), `openrouter/`, `nvidia/`, `openai/`, `groq/`, `local/` (Ollama), or no prefix for any OpenAI-compatible gateway. Bring your own provider with `registerProvider`. See the [plugin README](packages/plugin-ai-judge/README.md) for the full provider table and matcher reference.

## Project structure

A freshly scaffolded project (before any plugin):

```text
my-tests/
├── api/
│   ├── core/ApiClient.ts     # typed get/post/put/patch/delete over APIRequestContext
│   ├── services/             # business operations (PetService)
│   └── models/               # domain types (Pet, …)
├── config/                   # loadEnv, envUtils
├── env/environments.json     # BASE_URL (UI) + API_BASE_URL (API), per environment
├── fixtures/
│   ├── index.ts              # the @fixtures barrel (mergeTests / mergeExpects) — plugins merge here
│   ├── ui.ts                 # UI test/expect + `session` option + test.as auth
│   ├── api.ts                # apiClient + service fixtures (browser-free)
│   └── auth.ts               # lazy session login + caching
├── pages/                    # Page Object Models (BasePage, LoginPage)
├── testData/users.json       # named login sessions
├── tests/
│   ├── ui/                   # UI examples (login, authSession)
│   └── api/                  # API examples (*.api.ts)
├── utils/                    # apiUtils, dateUtils (framework-agnostic helpers)
├── playwright.config.ts      # chromium + api projects; plugin projects splice in via markers
├── tsconfig.json · eslint.config.js · .prettierrc · .commitlintrc.json
└── .husky/                   # pre-commit → lint-staged, commit-msg → commitlint
```

`add ai-judge` then adds `tests/ai-judge/` plus the wired fixtures and env keys.

## CLI reference

```text
npm init @pwtap@latest [dir] [flags]   # scaffold (dir defaults to ".")
npx create-pwtap add    <plugin...>    # add plugins to an existing project
npx create-pwtap remove <plugin...>    # remove plugins
```

Interactively, `create` asks the same questions as `npm init playwright` — tests-folder name, GitHub Actions workflow, install browsers, and (on Linux) install OS dependencies — minus TypeScript/JavaScript, since the platform is TypeScript-only. It also lists the optional plugins.

**Flags:** `-y` / `--yes` (accept defaults, skip the menu) · `--tests-dir <name>` (tests folder, default `tests`) · `--gha` (add a GitHub Actions workflow) · `--no-install` (skip `npm install`) · `--no-browsers` (skip the Playwright browser download) · `--ai-judge` (preselect a plugin).

## Configuration

**Environments** — `env/environments.json` holds per-environment scalars; select one with `TEST_ENV` (default `common.DEFAULT_TEST_ENV`). Every string is flattened to a `process.env` key by `config/loadEnv.ts`.

```json
{
  "common": { "DEFAULT_TEST_ENV": "dev" },
  "environments": {
    "dev": {
      "BASE_URL": "https://www.saucedemo.com/",
      "API_BASE_URL": "https://petstore3.swagger.io/api/v3"
    }
  }
}
```

`BASE_URL` is the UI `baseURL`; `API_BASE_URL` is the API project's base, kept separate so the two never collide. Run another environment with `TEST_ENV=staging npm test`.

**Login sessions** — declare named users in `testData/users.json`; select one with `test.use({ session: 'admin' })` or `test.as('admin')(...)`.

## Scripts

Scripts available inside a scaffolded project:

| Script                      | Does                                    |
| --------------------------- | --------------------------------------- |
| `npm test`                  | Run all tests (`chromium` + `api`)      |
| `npm run test:api`          | API tests only (no browser)             |
| `npm run test:ui`           | Playwright UI mode                      |
| `npm run test:headed`       | Headed run                              |
| `npm run test:debug`        | Debug mode                              |
| `npm run report:playwright` | Open the HTML report                    |
| `npm run codegen`           | Playwright codegen                      |
| `npm run lint` / `lint:fix` | ESLint                                  |
| `npm run format`            | Prettier                                |
| `npm run type-check`        | `tsc --noEmit`                          |
| `npm run commit`            | Commitizen (conventional commit prompt) |

## Development

Working on the platform itself (this monorepo):

```bash
npm install
npm run build      # tsc -b (solution build across all packages)
npm run lint
npm run smoke      # scaffold a core-only project into a temp dir and verify it builds + runs
```

Packages build in dependency order (`platform` → `core-template` → `create` → plugins). Plugins never import the core; they depend only on `@playwright/test` (peer), `@pwtap/platform`, and `process.env`.

## Releasing and publishing

Versioning and publishing are [changesets](https://github.com/changesets/changesets)-driven and run from the **Release** GitHub Action (manual `workflow_dispatch`).

1. Record a change: `npx changeset` — pick the affected packages and the bump level (`patch` / `minor` / `major`); the version number is computed for you.
2. Trigger **Release**. With pending changesets it opens a **Version Packages** PR (bumps versions, writes changelogs).
3. Merge that PR, then trigger **Release** again — it publishes the changed packages to npmjs.org and tags a GitHub Release.

Requires the `NPM_TOKEN` repo secret (an npm "Automation" token) and, for the Version PR, "Allow GitHub Actions to create and approve pull requests" enabled in the repo's Actions settings.

## Roadmap

- **Mobile** — `@pwtap/plugin-maestro` (Maestro flows), then `@pwtap/plugin-appium` (XCUITest / UiAutomator2).
- **More engines** — `@pwtap/plugin-k6` (performance), `-desktop`, `-security`.
- **Beyond macOS** — additive platform implementations behind `@pwtap/platform`.

## License

MIT
