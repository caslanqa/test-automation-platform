---
name: failure-triage
description: 'Classify a test failure as product bug, test bug, environment, or flake, using the error text, the retry outcome, and the diff — before changing any code. Use whenever a test or CI job fails and the cause is not yet established.'
requires: core
---

Four classes. Decide which one _before_ editing anything, because the wrong first move is expensive:
editing a test to pass a real regression is how a suite becomes a lie.

| Class           | Meaning                                         | Correct action                                 |
| --------------- | ----------------------------------------------- | ---------------------------------------------- |
| **product bug** | the app's behaviour or data changed             | report with a repro. **Do not touch the test** |
| **test bug**    | the test encodes an assumption that is not true | fix the test                                   |
| **environment** | harness, network, dependency or browser failed  | re-run the job; report the infra problem       |
| **flake**       | same code, same app, non-deterministic          | find the race. Neither outcome is evidence     |

## Evidence, in precedence order

**1. Did a retry pass? This outranks everything else.**

`retries` is `2` on CI, `0` locally. A test that failed and then passed in the same run is
Playwright's `flaky` outcome. Treat it as **flake**, even when the error text looks like a broken
locator: a locator that resolved on attempt 2 did not change, and a value that matched on attempt 2 is
not a regression. Locally, where retries are `0`, you have no such signal — re-run the single test a
few times before concluding anything.

**2. What kind of error is it?** The message shape is the strongest deterministic signal:

| Error text                                                                                                 | Reading                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `strict mode violation: … resolved to N elements`                                                          | the DOM changed — a selector that was unique no longer is                                                               |
| `expect(locator).toBeVisible() failed` with `Received: hidden` / `<element(s) not found>` and a `Timeout:` | the element is not there — DOM change, or the flow never got that far                                                   |
| `locator.click: Timeout … exceeded` with `waiting for` in the call log                                     | same as above, at an action                                                                                             |
| `Expected:` / `Received:` differing on a **value** (`toHaveText`, `toHaveValue`, `toHaveURL`, `toEqual`)   | **the data or behaviour changed — product bug until proven otherwise.** Never "fix" this by changing the expected value |
| `net::ERR_`, `ECONNREFUSED`, `page.goto: Timeout`                                                          | environment                                                                                                             |
| `Target crashed`, `Target page, context or browser has been closed`, `Protocol error`                      | environment                                                                                                             |
| an error thrown from a fixture or hook rather than an `expect`                                             | environment — setup failed, the test never really ran                                                                   |
| `timedOut` with no error at all                                                                            | unknown. Read the trace; do not guess                                                                                   |

**3. What changed?** `git diff --name-only <base>...HEAD`.

- The failing spec, or the page object in its stack, was edited → the test is the likely cause.
- Nothing in the repo changed and this test used to pass → the application moved.
- `package-lock.json` or `playwright.config.ts` changed → suspect environment first.

**4. Artifacts.** `test-results/` has the trace, video and screenshot (`retain-on-failure` /
`only-on-failure`); `{{script:report:playwright}}` opens the HTML report. **Read the trace before
theorising** — the trace shows which step failed and what the page looked like, which usually ends
the argument.

## The rule that matters most

A value mismatch is not a locator problem. If `Expected: "Welcome, Ada"` and `Received: "Welcome,
Grace"`, the test is doing its job. Changing the expected value makes the suite green and the bug
invisible, and it is the single most damaging edit available in a test suite.

## Output

State the class, the one piece of evidence that decided it, and the next action with an owner. If the
evidence does not settle it, say **cannot tell** and name what would settle it — one more run, a
trace that was not retained, a log you do not have. That is a real answer; a confident guess here
becomes a code change.
