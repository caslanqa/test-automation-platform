---
name: risk-to-layer
description: 'Pick the test layer for a given risk — API, UI, or a specialist plugin layer — and know when duplicating a check across layers is correct. Use when planning coverage, when the suite is slow because everything is a UI test, or when deciding where a new check belongs.'
requires: core
---

The rule: **the cheapest layer that can still observe the thing, and no cheaper.**

Cost is not only runtime. A check at the wrong layer fails for reasons unrelated to what it tests,
which means it blames the wrong component and trains everyone to ignore it.

## Read the config first

Only the projects in `playwright.config.ts` exist. Core ships two:

- **`api`** — `tests/api/**/*.api.ts`, no browser, built on `api/core/ApiClient.ts` and wired from
  `API_BASE_URL`.
- **`chromium`** — the UI project.

Every optional plugin adds an **env-gated** project, so a bare `npm test` is UI + API only. Before
recommending a layer, confirm the project for it is actually installed — recommending a layer the
project does not have produces a test that never runs.

## The mapping

| The risk is about                              | Layer      | Why not one layer up                                                                                 |
| ---------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| status codes, error bodies, field validation   | `api`      | a browser adds a page load and a form fill to observe what the response says directly                |
| authorization boundaries (role X cannot do Y)  | `api`      | the UI often just hides the button; hiding is not enforcing, and only the API test proves the latter |
| contract shape, required fields, pagination    | `api`      | none of it is visible on screen anyway                                                               |
| what the user sees, an interaction, a redirect | `chromium` | there is no cheaper layer that observes rendering                                                    |
| a rendered error message's exact text          | `chromium` | the API test proves the code, not the copy                                                           |
| navigation and route guards                    | `chromium` | the redirect is the observable                                                                       |

## When duplication is right

Duplicate a check across layers only when **the same rule is enforced in two places** and both
enforcements can independently break. The canonical case: an authorization rule enforced in the API
_and_ reflected by a hidden control in the UI. Two tests, and say in each one which enforcement it
covers. Any other duplication is one test too many.

## The two traps

- **An API rule tested through the UI.** The most common source of slow, flaky suites. If the
  observable is a status code or a response field, it is an `api` test.
- **A UI test that only asserts data.** If the test drives a browser and then asserts a value the API
  returned, it is an API test that happens to have opened a browser.

## Writing the delta

A strategy is a delta, not an inventory. Produce:

1. criteria already covered — name the file
2. criteria needing a new test — and the layer
3. existing tests that should **move down** a layer, or be deleted as redundant

A strategy that only adds tests is not a strategy; it is a wish list, and the suite gets slower every
time one is written.
