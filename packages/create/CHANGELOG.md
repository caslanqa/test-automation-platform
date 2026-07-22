# @pwtap/create

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
