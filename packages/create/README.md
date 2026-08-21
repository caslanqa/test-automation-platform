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
npx @pwtap/create add ai-judge      # installs @pwtap/plugin-ai-judge + wires expect / env / example
npx @pwtap/create remove ai-judge
```

| Plugin           | Package                  | Flag         | Adds                                                        |
| ---------------- | ------------------------ | ------------ | ----------------------------------------------------------- |
| AI Judge         | `@pwtap/plugin-ai-judge` | `--ai-judge` | LLM-as-judge matchers on `expect`                           |
| Maestro (mobile) | `@pwtap/plugin-maestro`  | `--maestro`  | `maestro` project, `mobileApp` fixture, device lifecycle    |
| Appium (mobile)  | `@pwtap/plugin-appium`   | `--appium`   | `appium` project, same `mobileApp` fixture, WDA/UiAutomator |
| Database         | `@pwtap/plugin-db`       | `--db`       | Knex SQL + MongoDB fixtures and assertions                  |
| Performance      | `@pwtap/plugin-perf`     | `--perf`     | In-suite vitals with budgets, plus k6 load scenarios        |
| Healing          | `@pwtap/plugin-heal`     | `--heal`     | Failure triage, flake detection, quarantine, locator repair |

You can also preselect at scaffold time: `npm init @pwtap@latest my-tests --ai-judge --heal`.

`remove` is a real undo: it restores the marker regions the plugin spliced into `fixtures/index.ts` and
`playwright.config.ts`, drops its scripts and env keys, and leaves example specs you may have built on.

## Agents and MCP, rendered from the plugins you have

Claude Code has no conditional component loading, so gating is this package's job. `claude-plugin-path`
renders an agent plugin **for the project it is pointed at** and prints its path — a project with no mobile
plugin gets no mobile agent, and `add appium` makes one appear on the next session.

```text
/plugin marketplace add caslanqa/test-automation-platform
/plugin install pwtap@pwtap
```

The same render derives `.mcp.json` from the MCP servers your installed plugins declare, so nothing is
written into your repository and `remove maestro` un-declares the server by itself. For any other MCP
client, `mcp` prints an equivalent block and writes nothing:

```bash
npx @pwtap/create mcp
```

## CLI reference

```
npm init @pwtap@latest [dir] [flags]   # scaffold (dir defaults to ".")
npx @pwtap/create add    <plugin...>    # add plugins to an existing project
npx @pwtap/create remove <plugin...>    # remove plugins
npx @pwtap/create mcp [--project <dir>]          # print an mcpServers block (writes nothing)
npx @pwtap/create init-agents [--loop=claude] [--project <dir>]
                                        # write the V&V agents into <project>/.claude/ (no marketplace)
npx @pwtap/create claude-plugin-path [--project <dir>]
                                        # render the agent plugin, print its path (Claude Code calls this)
```

`npm init @pwtap` and `npx @pwtap/create` are the same program: the first is npm's scaffolding convention,
the second is how you reach the subcommands afterwards. There is no `create-pwtap` package on the registry
— `npm i -g @pwtap/create` if you want the short name.

Flags: `-y` / `--yes` (accept defaults, skip the menu), `--no-install` (skip `npm install`), `--no-browsers` (skip the Playwright browser download), `--tests-dir <name>` (tests folder), `--gha` (add a GitHub Actions workflow), and one per plugin (`--ai-judge`, `--maestro`, `--appium`, `--db`, `--perf`, `--heal`).

Interactively (no `-y`), `create` first collects **package.json metadata** — name, version, description, author (defaulted from your git identity), keywords, repository URL, license — then the platform questions: tests-folder name, plugins, GitHub Actions workflow, install browsers, and (on Linux) OS dependencies. Press Enter to accept any default.

## Requirements

- **Node.js ≥ 22.23**
- macOS-first; other OSes are additive (mobile/desktop engines are macOS today).

## License

MIT
