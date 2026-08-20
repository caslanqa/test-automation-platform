---
name: read-run-artifacts
description: "Where a run's evidence lives — traces, videos, screenshots, the JSON reporter output and the Allure results — and how to read it before theorising. Use whenever a failure needs investigating or a run needs summarising."
requires: cap:allure
---

Read the artifacts before forming a theory. A trace answers in seconds what a guess argues about for
an hour.

## What is written, and where

| Path                        | What it is                                                            |
| --------------------------- | --------------------------------------------------------------------- |
| `test-results/`             | The `outputDir`: per-test traces, videos, screenshots and attachments |
| `test-results/results.json` | The JSON reporter — the machine-readable run                          |
| `playwright-report/`        | The HTML report. Open it with `{{script:report:playwright}}`          |
| `allure-results/`           | Raw Allure results, for whatever renders them in CI                   |

Capture is failure-driven: `screenshot: 'only-on-failure'`, `video: 'retain-on-failure'`,
`trace: 'retain-on-failure'`. So a passing test leaves nothing, and **a failure with no artifacts
usually means the process died before Playwright could write them** — which is itself the finding.

All of these are gitignored. On CI they exist only if the workflow uploaded them; if it did not,
say so rather than reasoning from the exit code.

## Read the trace first

The trace is the only artifact that shows _which step_ failed and what the page looked like at that
moment:

```
npx playwright show-trace test-results/<test-dir>/trace.zip
```

It carries the action timeline, the DOM snapshot before and after, the console and the network. Two
things it settles immediately: whether the element was absent or merely unmatched, and whether the
flow ever reached the failing step.

## Reading results.json without being misled

The structure is `suites → specs → tests → results`, and the trap is in the last level: **`results`
is one entry per attempt, not per test.** A test that failed and then passed on retry appears as two
entries. Counting `results` gives you attempts, and counting failures that way double-counts every
flake as both a failure and a pass.

So: group by test, and decide the outcome from the _last_ attempt plus whether an earlier one failed.
Failed-then-passed is a **flake** — the distinction that matters most, and the one a naive count
erases.

## The questions to answer from a run

1. Which projects ran? A bare `{{script:test}}` runs `chromium` and `api` only; every plugin project
   is env-gated.
2. How many tests were skipped, and why? Skips do not show up in a pass count.
3. How many passed only on retry? Those are flakes, not passes.
4. Which environment was it? `TEST_ENV` selects a block in `env/environments.json`.
5. For the change in question: did the assertion that would catch a regression actually execute?
