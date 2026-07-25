# @pwtap/create

Scaffold a **Playwright Test Automation Platform** project — an editable UI + API testing core with opt-in, separately-published plugins.

[![npm](https://img.shields.io/npm/v/@pwtap/create)](https://www.npmjs.com/package/@pwtap/create)
[![license](https://img.shields.io/npm/l/@pwtap/create)](https://github.com/caslanqa/test-automation-platform/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@pwtap/create)](https://nodejs.org)

> **This is a scaffolder (`create-*`), not a library.** The `npm i …` box npm shows at the top of this page is auto-generated — **don't use it.** Create a ready-to-run project with `npm init` / `npm create`:

```bash
npm init @pwtap@latest my-tests
```

## What you get

The core is **copied into your project as editable source** (not imported from `node_modules`):

- **UI testing** — Chromium + Page Object Model (`BasePage`, `LoginPage`).
- **API testing** — layered `ApiClient` → service → test in a browser-free `api` project (Petstore v3 example).
- **Lazy session auth** — named sessions logged in once and cached per worker; opt in per test or per suite.
- **One fixtures barrel** (`@fixtures`) composed with `mergeTests`/`mergeExpects` — plugins merge into it.
- **Tooling out of the box** — ESLint, Prettier, husky + lint-staged, commitlint.

## After scaffolding

```bash
cd my-tests
cp env/environments.example.json env/environments.json   # BASE_URL (UI) + API_BASE_URL (API)
cp testData/users.example.json   testData/users.json      # named login sessions (optional)
npm test
```

## Auth — per suite or per test

```ts
import { test, expect } from '@fixtures';

test.use({ session: 'admin' }); // whole file / describe
test('dashboard', async ({ page }) => {
  /* signed in as admin */
});

test.as('customer')('checkout', async ({ page }) => {
  /* just this test */
});
test.as('admin').skip('wip', async () => {}); // .skip/.only/.fixme/.fail supported
```

## Plugins (opt-in)

Add or remove engines any time — real npm packages, wired via a typed manifest:

```bash
npx create-pwtap add ai-judge      # installs @pwtap/plugin-ai-judge + wires expect / env / example
npx create-pwtap remove ai-judge
```

| Plugin           | Package                  | Status         |
| ---------------- | ------------------------ | -------------- |
| AI Judge         | `@pwtap/plugin-ai-judge` | ✅ stable      |
| Maestro (mobile) | `@pwtap/plugin-maestro`  | 🚧 coming soon |
| Appium (mobile)  | `@pwtap/plugin-appium`   | 🚧 coming soon |

You can also preselect at scaffold time: `npm init @pwtap@latest my-tests --ai-judge`.

## CLI reference

```
npm init @pwtap@latest [dir] [flags]   # scaffold (dir defaults to ".")
npx create-pwtap add    <plugin...>    # add plugins to an existing project
npx create-pwtap remove <plugin...>    # remove plugins
```

Flags: `-y` / `--yes` (accept defaults, skip the menu), `--no-install` (skip `npm install`), `--no-browsers` (skip the Playwright browser download), `--tests-dir <name>` (tests folder), `--gha` (add a GitHub Actions workflow), `--ai-judge` (preselect a plugin).

Interactively (no `-y`), `create` first collects **package.json metadata** — name, version, description, author (defaulted from your git identity), keywords, repository URL, license — then the platform questions: tests-folder name, plugins, GitHub Actions workflow, install browsers, and (on Linux) OS dependencies. Press Enter to accept any default.

## Requirements

- **Node.js ≥ 22.23**
- macOS-first; other OSes are additive (mobile/desktop engines are macOS today).

## License

MIT
