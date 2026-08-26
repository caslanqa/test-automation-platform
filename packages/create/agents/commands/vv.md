---
name: vv
description: 'Run the verification & validation pass for a change, a stage, or a failing run. Takes what to verify as its argument.'
requires: core
---

Run a V&V pass on: **$ARGUMENTS**

If that is empty, verify the current uncommitted change — `git status --short` and
`git diff --stat` tell you what it is.

Work as `{{ref:vv-lead}}` does: pick the _earliest_ stage with an unanswered question, delegate to the
agent that owns it, and end with a verdict.

| The argument looks like                          | Start at                                  |
| ------------------------------------------------ | ----------------------------------------- |
| a requirement, ticket, or story                  | `{{ref:story-reviewer}}`                  |
| "where should this be tested", coverage planning | `{{ref:test-strategist}}`                 |
| "write a test for…"                              | `{{ref:test-author}}`                     |
| a diff, a PR, or a file of tests                 | `{{ref:suite-reviewer}}`                  |
| a failure, a red job, a stack trace              | `{{ref:run-triage}}`                      |
| "is this requirement tested", a coverage gate    | `{{ref:story-reviewer}}`, then the matrix |
| "can this ship", "are we ready"                  | `{{ref:vv-lead}}`, and work backwards     |

Only agents listed in `{{rosterReport}}` exist in this project — the roster is
rendered from the plugins actually installed here. If the task needs a capability that is not
installed, say which plugin would provide it rather than improvising around the gap.

End with:

- the verdict — **ready**, **not ready**, or **cannot tell**
- for **not ready**: each blocker, where it lives, and who owns it
- for **cannot tell**: exactly what evidence is missing

Where the project has a traceability matrix, a verdict has one more source of evidence:
`npm run tms:trace` — where `@pwtap/plugin-tms` is installed — says which requirements are **covered**
and which are actually **verified**, and
those are not the same claim — a requirement whose only test was skipped or never ran is neither. Read
the verdict column, not the presence of a row.

Do not report a suite as verified because it is green. Check that the project which would have caught
the problem actually ran — a bare `{{script:test}}` runs `chromium` and `api` only, and every plugin
project is env-gated.
