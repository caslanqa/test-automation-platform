---
'@pwtap/create': minor
---

Scaffolder now mirrors the official `npm init playwright` questions: a tests-folder name (renames the folder and repoints the Playwright config `testDir`, the tsconfig `@tests` alias, and the eslint test glob), an optional GitHub Actions workflow, whether to install browsers, and — on Linux — whether to install OS dependencies. TypeScript/JavaScript is intentionally not asked (the platform is TypeScript-only). Adds non-interactive flags `--tests-dir <name>` and `--gha`, and records the chosen folder in `package.json` (`pwtap.testsDir`) so a later `add` copies plugin examples into it.
