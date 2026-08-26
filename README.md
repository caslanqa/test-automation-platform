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
- [Healing and triage](#healing-and-triage)
- [Mobile MCP](#mobile-mcp)
- [Agentic V&V](#agentic-vv)
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

- **Node.js ≥ 22.23**
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
npx @pwtap/create add ai-judge          # installs @pwtap/plugin-ai-judge and wires it in
```

## Packages

This repository is an npm-workspaces monorepo.

| Package                                                | Role                                                                                        | Published  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ---------- |
| [`@pwtap/create`](packages/create)                     | The scaffolder — `npm init @pwtap`. Copies the editable core in and wires plugins.          | ✅         |
| [`@pwtap/platform`](packages/platform)                 | macOS-first platform seam (paths, shell, device discovery/boot, lock) used by plugins.      | ✅         |
| [`@pwtap/plugin-ai-judge`](packages/plugin-ai-judge)   | LLM-as-judge matchers (`toPassRubric` / `toScoreAtLeast` / `toMatchImage`), multi-provider. | ✅         |
| [`@pwtap/mobile-core`](packages/mobile-core)           | Driver-neutral mobile contracts, locator scoring, and the adapter registry.                 | ✅         |
| [`@pwtap/mobile-inspector`](packages/mobile-inspector) | Recorder and inspector for mobile flows — `npx mobile-inspect`.                             | ✅         |
| [`@pwtap/plugin-maestro`](packages/plugin-maestro)     | Mobile testing with Maestro flows (Android + iOS).                                          | ✅         |
| [`@pwtap/plugin-appium`](packages/plugin-appium)       | Mobile testing with Appium (XCUITest, UiAutomator2).                                        | ✅         |
| [`@pwtap/plugin-db`](packages/plugin-db)               | Database testing — Knex SQL (Postgres/MySQL/MariaDB/SQLite) and MongoDB.                    | ✅         |
| [`@pwtap/plugin-perf`](packages/plugin-perf)           | Performance — in-suite vitals and budgets, plus k6 load scenarios.                          | ✅         |
| [`@pwtap/plugin-heal`](packages/plugin-heal)           | Failure triage, flake detection and quarantine — advisory, never rewrites an assertion.     | ✅         |
| [`@pwtap/plugin-tms`](packages/plugin-tms)             | Test management sync (Qase) — cases from your specs, runs and results with every artifact.  | ✅         |
| `@pwtap/core-template`                                 | The editable core source that `@pwtap/create` bundles. Private — never published.           | —          |
| `@pwtap/plugin-desktop` · `-security`                  | Desktop / security engines.                                                                 | 🚧 planned |

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
npx @pwtap/create add ai-judge          # install + wire (fixtures, env keys, example spec, project)
npx @pwtap/create remove ai-judge       # cleanly undo
```

| Plugin           | Package                  | Flag         | Adds                                                        |
| ---------------- | ------------------------ | ------------ | ----------------------------------------------------------- |
| AI Judge         | `@pwtap/plugin-ai-judge` | `--ai-judge` | LLM-as-judge matchers on `expect`                           |
| Maestro (mobile) | `@pwtap/plugin-maestro`  | `--maestro`  | `maestro` project, `mobileApp` fixture, device lifecycle    |
| Appium (mobile)  | `@pwtap/plugin-appium`   | `--appium`   | `appium` project, same `mobileApp` fixture, WDA/UiAutomator |
| Database         | `@pwtap/plugin-db`       | `--db`       | Knex SQL + MongoDB fixtures and assertions                  |
| Performance      | `@pwtap/plugin-perf`     | `--perf`     | In-suite vitals with budgets, plus k6 load scenarios        |
| Healing          | `@pwtap/plugin-heal`     | `--heal`     | Failure triage, flake detection, quarantine, locator repair |
| Test management  | `@pwtap/plugin-tms`      | `--tms`      | Qase sync — cases from your specs, runs, results, artifacts |

Each plugin registers an env-gated Playwright project, so a bare `npm test` always stays UI + API only. You can also preselect at scaffold time with a flag, e.g. `npm init @pwtap@latest my-tests --ai-judge --heal`.

Every plugin is reversible. `remove` restores the marker regions it spliced, drops its scripts and env keys, and leaves any example spec you may have built on — nothing is stranded and nothing is silently kept.

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

## Healing and triage

[`@pwtap/plugin-heal`](packages/plugin-heal) answers the question every red run starts with — **is this a
bug, a flake, or a moved element?** — before anything is allowed to change.

```bash
npx @pwtap/create add heal

npx playwright test          # the reporter records every run to .heal/runs/
npm run heal:triage          # classify what failed
npm run heal:propose         # rank locator replacements, prove one, verify it. Writes nothing
npm run heal:gate            # CI: exit 1 on a quarantine violation or an unshielded failure
```

```text
  → locator-drift  (90, act)  [chromium] checkout › the pay button submits
      · the error is strict-mode
      · nothing in the repository changed, so the application moved

  ✗ true-fail  (85, act)  [chromium] cart › the badge counts items
      · the error is value-mismatch
      no autofix: value-mismatch: the expected value is the test doing its job
```

A **value mismatch is never healed**: if `Expected: "Welcome, Ada"` meets `Received: "Welcome, Grace"`, the
test is doing its job, and rewriting the expectation would make the suite green and the bug invisible.
Only `locator-drift` is ever repaired, only with a proven equivalence, and only after three consecutive
greens with retries off — and the output is always a reviewable proposal, never a commit.

Quarantine replaces `test.fixme()`: a quarantined test **still runs**, its trace and video are still in the
report, and only the run's exit status is suppressed. Entries expire, are budgeted, and a ratchet requires
a reason in the pull request for the list to grow.

Everything above is deterministic and offline. An optional tier can ask a model about failures that stayed
`unknown`, and four rules in code — not in the prompt — mean **it can never authorise a code change**. Full
guide: [plugin README](packages/plugin-heal/README.md) and
[`docs/heal-plugin-plan.md`](docs/heal-plugin-plan.md).

## Mobile MCP

With a mobile plugin installed, `@pwtap/mobile-inspector` also serves an MCP server, so an agent can drive
a device through the same contracts your tests use:

```bash
npm run mcp:mobile           # or: npx @pwtap/create mcp   → prints a config block for any MCP client
```

Nine tools. The one that earns it is `mobile_locators`, which returns **ranked, uniqueness-checked,
fragility-annotated** candidates — something no shell command produces, and without which an agent writing
a mobile test writes coordinate taps.

Acting on the device is **off by default** (`mobile_perform` stays listed and refuses, naming the switch),
there is deliberately no shell, `adb`, `simctl`, uninstall or erase tool, and screen text is quoted to the
model as data. If you use the Claude Code plugin above, the configuration is derived automatically from the
plugins you have — installing `maestro` gives an agent the mobile tools, removing it takes them away.
Design notes: [`docs/mcp-plan.md`](docs/mcp-plan.md).

## Agentic V&V

A team of verification & validation agents for Claude Code, **rendered from the plugins your project
actually has**. Install it once:

```text
/plugin marketplace add caslanqa/test-automation-platform
/plugin install pwtap@pwtap
```

A core-only project gets six agents — `vv-lead`, `story-reviewer`, `test-strategist`, `test-author`,
`suite-reviewer`, `run-triage` — plus four skills and `/pwtap:vv` and `/pwtap:vv-status`. Add a plugin
and the agents for it appear on the next session; remove it and they go. There is nothing to sync:
Claude Code re-runs the renderer once per session and reloads when the output changes.

| Installed                        | You also get                               |
| -------------------------------- | ------------------------------------------ |
| `maestro` or `appium`            | `mobile-vv` agent, `mobile-locators` skill |
| `db`                             | `db-state-verification` skill              |
| `perf`                           | `perf-budgets` skill                       |
| `ai-judge`                       | `ai-judge-rubrics` skill                   |
| a `.github/workflows/` directory | `release-gate` agent                       |

Run `/pwtap:vv-status` to see which project was detected, which capability tokens that produced, and
what each one gated in or out. Because Claude Code runs the renderer from your home directory rather
than from the session's folder, it finds your project via `--project`, then `PWTAP_PROJECT`, then a
registry that `create-pwtap` writes. If the roster looks wrong, that is almost always why — set
`PWTAP_PROJECT` in your shell profile to pin it.

Requires Claude Code **2.1.229 or newer**. On anything older, or in an organisation whose managed
settings block command plugin sources, use the fallback instead:

```bash
npx @pwtap/create init-agents --loop=claude
```

That writes the same components into `<project>/.claude/`, invoked bare (`/vv`, `@vv-lead`), without
touching anything already in that directory. It is a static snapshot — re-run it after `add` or
`remove`. Design notes and the decision log: [`docs/agentic-vv-plan.md`](docs/agentic-vv-plan.md).

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
npx @pwtap/create add    <plugin...>    # add plugins to an existing project
npx @pwtap/create remove <plugin...>    # remove plugins
npx @pwtap/create init-agents [--loop=claude] [--project <dir>]
                                       # write the V&V agents into <project>/.claude/
npx @pwtap/create claude-plugin-path [--project <dir>]
                                       # render the agent plugin, print its path (used by Claude Code)
npx @pwtap/create mcp [--project <dir>] # print an mcpServers block for any MCP client (writes nothing)
```

`npm init @pwtap` and `npx @pwtap/create` are the same program — the first is npm's scaffolding convention,
the second is how you reach the subcommands afterwards. There is no `create-pwtap` package on the registry;
if you want the short name, install it yourself with `npm i -g @pwtap/create`.

Interactively, `create` asks the same questions as `npm init playwright` — tests-folder name, GitHub Actions workflow, install browsers, and (on Linux) install OS dependencies — minus TypeScript/JavaScript, since the platform is TypeScript-only. It also lists the optional plugins.

**Flags:** `-y` / `--yes` (accept defaults, skip the menu) · `--tests-dir <name>` (tests folder, default `tests`) · `--gha` (add a GitHub Actions workflow) · `--no-install` (skip `npm install`) · `--no-browsers` (skip the Playwright browser download) · one per plugin: `--ai-judge`, `--maestro`, `--appium`, `--db`, `--perf`, `--heal`.

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

Plugins add their own. `add heal` brings seven:

| Script                    | Does                                                            |
| ------------------------- | --------------------------------------------------------------- |
| `npm run heal:triage`     | Classify this run's failures                                    |
| `npm run heal:propose`    | Rank locator replacements, prove one, verify it. Writes nothing |
| `npm run heal:gate`       | CI gate — quarantine budget plus unshielded failures            |
| `npm run heal:quarantine` | What is quarantined, and for how much longer                    |
| `npm run heal:calibrate`  | Grade the classifier against your labelled cases (offline)      |
| `npm run heal:metrics`    | Did the heals hold, and did any of them hide something?         |
| `npm run heal:baseline`   | Fold runs into the committed flake history                      |

`add maestro` or `add appium` bring `test:maestro` / `test:appium`, `mobile:inspect`, `mobile:create-device`, `mobile:stop-devices` and `mcp:mobile`.

## Development

Working on the platform itself (this monorepo):

```bash
npm install
npm run build      # tsc -b (solution build across all packages)
npm run lint
npm run smoke      # scaffold a core-only project into a temp dir and verify it builds + runs
```

Packages build in dependency order (`platform` → `core-template` → `create` → plugins). Plugins never import the core; they depend only on `@playwright/test` (peer), `@pwtap/platform`, and `process.env`.

To build locally and install into a throwaway project **without publishing** (the tarball loop), see **[Local development & install](docs/LOCAL_DEVELOPMENT.md)**.

## Releasing and publishing

Versioning and publishing are [changesets](https://github.com/changesets/changesets)-driven, run from the **Release** GitHub Action — manual, one-shot (`workflow_dispatch`, no Version PR, no separate merge step) and branch-aware.

1. Record a change: `npx changeset` — pick the affected packages and the bump level (`patch` / `minor` / `major`); the version number is computed for you.
2. Trigger **Release** from the Actions tab, choosing which branch to run it from:
   - **From `main`** — the stable release. Bumps versions, writes changelogs, commits the bump to main, publishes to npm's `latest` tag, and pushes the release tags. One click, no PR to merge.
   - **From any other branch** — a throwaway **snapshot** release (changesets' own mechanism for this). Publishes under an npm tag derived from the branch name (e.g. `feat/my-thing` → `feat-my-thing`) with a unique `0.0.0-<tag>-<timestamp>` version. `latest` is never touched and nothing is committed — install a branch build with `npm install @pwtap/<pkg>@<branch-tag>`.

Requires the `NPM_TOKEN` repo secret (an npm "Automation" token) and, for the main-branch version-bump commit, permission for `github-actions[bot]` to push to `main` (add it to the branch protection rule's bypass list if `main` requires a PR). Branch snapshot releases never push to git, so that requirement doesn't apply to them.

## Roadmap

- **Mobile** — `@pwtap/plugin-maestro` (Maestro flows), then `@pwtap/plugin-appium` (XCUITest / UiAutomator2).
- **More engines** — `@pwtap/plugin-k6` (performance), `-desktop`, `-security`.
- **Beyond macOS** — additive platform implementations behind `@pwtap/platform`.

## License

MIT
