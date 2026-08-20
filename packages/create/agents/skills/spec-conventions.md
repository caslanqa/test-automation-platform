---
name: spec-conventions
description: 'The rules a @pwtap spec must follow — import test/expect from @fixtures, page objects under pages/, no hardcoded waits, and never edit inside a pwtap: marker region. Use before writing or reviewing any test file in this project.'
requires: core
---

## The barrel is not optional

```ts
import { test, expect } from '@fixtures';
```

`fixtures/index.ts` merges the core UI and API fixtures with every installed plugin's fixtures and
custom matchers, via `mergeTests` / `mergeExpects`. Importing from `@playwright/test` in a spec gets
you a `test` with none of them. Nothing fails at compile time; you find out when a fixture is
`undefined` or a matcher does not exist.

## Machine-managed regions — never edit inside

Two files are partly owned by `create-pwtap add|remove`:

| File                   | Regions                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `fixtures/index.ts`    | `pwtap:plugins:imports`, `pwtap:plugins:tests`, `pwtap:plugins:expects` |
| `playwright.config.ts` | `pwtap:plugins:gates`, `pwtap:plugins:projects`                         |

A region runs from `// pwtap:<key>` to `// pwtap:<key>:end`. Edit freely **outside** them. Inside,
your change is overwritten on the next `add` or `remove` — and deleting a marker is worse than
editing one: the tool then refuses to splice and prints a paste block instead, so the next plugin
install silently does nothing.

## Where things live

| What                | Where                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------- |
| UI / general spec   | `{{testsDir}}/**/*.spec.ts`                                                                  |
| API spec            | `{{testsDir}}/api/**/*.api.ts` — the suffix is what the `api` project matches                |
| Page objects        | `pages/`, extending `BasePage.ts`                                                            |
| Shared helpers      | `utils/` — `waitUtils`, `uiUtils`, `apiUtils`, `stringUtils`, `dateUtils`, `validationUtils` |
| Named users         | `testData/users.json`                                                                        |
| Environment scalars | `env/environments.json`                                                                      |

`**/setup/**`, `**/helpers/**` and `*.helper.ts` are ignored by `testMatch`, so a file there is never
collected — which is a feature until someone puts a real spec in `helpers/` and wonders why it never
runs.

## Locators, in order of preference

1. `getByTestId` — put there for tests, changed on purpose
2. `getByRole(role, { name })` — survives redesigns, and it is what the user perceives
3. `getByLabel`
4. `getByPlaceholder`
5. `getByText`
6. CSS or XPath — a future failure with a scheduled date

`BasePage.ts` already wraps the role- and label-based lookups. If a flow is needed by more than one
spec, it belongs in a page object, not copied.

## Waiting

Web-first assertions wait on their own — `await expect(locator).toBeVisible()` retries until the
`expect` timeout. So:

- Never `page.waitForTimeout(n)`. Too short on CI, wasted locally, and it hides the real condition.
- Never `waitForLoadState('networkidle')`. Discouraged by Playwright, and unreliable against any app
  that polls.
- For a condition no assertion expresses, use `waitUtils.ts`'s poll/retry with backoff.

## Assertions

- Assert the state you expect, never a conditional: `if (await x.isVisible()) expect(...)` passes when
  the element is missing, which is the opposite of a test.
- One behaviour per test. A test asserting five unrelated things reports one failure and hides four.
- Titles say the behaviour: `'rejects an expired card'`, not `'card test 2'`.

## Isolation

`fullyParallel: true` is on and workers are `2` on CI. Order is not a contract, and no test may
depend on another's state. Session auth is per-worker and lazy — `test.use({ session: 'admin' })` for
a file or describe, `test.as('admin')(…)` for one test, nothing at all for a public page.

## Environments

A run is always against one environment. `TEST_ENV=staging {{script:test}}` selects the block in
`env/environments.json`; `config/loadEnv.ts` flattens it onto `process.env` before the config is
defined. Never hardcode a URL in a spec — `baseURL` and the API client already carry it.
