# Auto-healing engine — plan and decision log

## Context

Nothing in this repo could answer "why did that run fail?" There was no custom Playwright reporter, no
typed run or result model, and no run history at all: `test-results/` is gitignored and CI uploaded no
artifacts. The only retry intelligence that existed was artifact gating — the video and screenshot mode
tables keyed on `testInfo.retry` in the mobile plugins.

The target is an engine that classifies a failure **before** anything changes, and whose autofix is
restricted to the one class where a change is provably safe. The reference point is Playwright's own
healer agent, which is explicitly instructed to update "assertions and expected values" and to mark a
stubborn test `test.fixme()`. Both convert a caught regression into a green suite, which is the failure
mode this design exists to avoid.

This is Phase 2 of three. Phase 1 shipped the agentic V&V plugin (`docs/agentic-vv-plan.md`); Phase 3
ships a mobile MCP server. **Phase 2 depends on neither**: agents are a nicer front end over this
CLI, never a way to reach a verdict it cannot.

## What is built (steps 1–5 of 8)

| Step | Contents                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------- |
| 1    | Reporter, run history, `testKey`, and `create`'s `reporter` manifest field + injector + marker |
| 2    | Error taxonomy, fingerprints, `classify`, `heal triage`                                        |
| 3    | Quarantine, `heal gate`, the CI step                                                           |
| 4    | `scripts/smoke-heal.mjs`                                                                       |
| 5    | Candidate generation, the equivalence proof, the rerun protocol, patches, `heal propose`       |

Deliberately **not** built yet: metrics and calibration (6); the LLM escalation tier (7); mobile
parity (8). Everything so far is deterministic and offline — no model anywhere, and the only browser
work is the verification rerun, which is the shipped Playwright the project already has.

## Architecture

```
packages/plugin-heal/                zero runtime dependencies; @playwright/test is a peer
  src/types.ts                       RunRecord → TestRecord → AttemptRecord → FailureRecord
  src/reporter.ts                    the ./reporter entry point — five hooks
  src/history/{testKey,runStore,flakeStats}.ts
  src/triage/{ansi,errorTaxonomy,fingerprint,gitDiff,classify}.ts
  src/quarantine/{file,shield,gate}.ts
  src/cli/{args,index}.ts + bin/heal.mjs
  docs/HEALING.md                    copied into the client by manifest.docs
```

In the **client** project: the reporter line (spliced into `playwright.config.ts`), `.heal/runs/`
(gitignored, ephemeral) and `heal/quarantine.json` (committed policy). Triage, gates and metrics run
out of band, from the CLI, so nothing costs a millisecond inside a test.

## Step 5: where the candidates come from

**Playwright already captures the page for us.** Every failure gets an `error-context` attachment, and
inside it is an ARIA snapshot of the page _at the moment the matcher failed_ — the same perception the
official healer obtains through an MCP `browser_snapshot` call. The reporter was already recording that
attachment's path, so candidate generation needs no fixture, no probe run, no second browser and no new
dependency.

That is not merely convenient. The obvious alternative — the auto-fixture the original plan called for
— would have to depend on `page`, and an `auto: true` fixture's dependencies are always instantiated,
so **every test in every project would launch a browser**, including an API-only project. Reading a
file Playwright already wrote costs nothing on a green run.

The snapshot gives roles, accessible names, properties (`/placeholder`, `/url`) and the nesting that
yields each element's landmark path. It cannot give test ids, classes or DOM paths — which costs
nothing, because a drifted locator has lost its identifier by definition.

## Step 5: the plan contradicted itself, and the fix is a graded proof

The plan asked for a binary rule — "two independent signals or refuse" — and in the same breath
expected `locator('#login-button')` to be auto-repaired into `getByRole('button', { name: 'Log in' })`.
Both cannot hold. A test-id or CSS-id locator states exactly one thing, and nothing in the code says
the element was a button labelled "Log in": that replacement is a reasonable human guess, not a proof.

So the verdict is graded, and only the strongest is ever applied:

| Verdict   | When                                                                                | Applied                 |
| --------- | ----------------------------------------------------------------------------------- | ----------------------- |
| `proven`  | two of the locator's signals match, the candidate is unique, any stated scope holds | eligible with `--apply` |
| `likely`  | one signal matches and that name is unique page-wide                                | advisory                |
| `moved`   | signals match but the candidate is outside the container the locator named          | advisory                |
| `refused` | nothing shared to check, not unique, or below the score floor                       | never                   |

An identifier-only locator therefore lands on `refused` **with the ranked candidates still attached** —
the list a human would have written out by hand — and no claim that any of them was verified.

**A safety hole found by a test, not by review.** With a name repeated in two containers, the ranking
led with the wrong one and role+name then "proved" it: a `Continue` button in a dialog was proven for a
locator scoped to `form.signin`. A structural scope cannot constrain the _class_ — that is what drifted
— but it does constrain the _kind_ of container, so the replacement must now be inside a `form`.

## Step 5: verification, and one more measured limit

The rerun protocol is three consecutive greens with `--retries=0` under `--workers=1` (a heal validated
by a retry is not validated), then the whole file at the configured concurrency, and the matcher that
failed has to reappear as a step in a green attempt or the replacement may have made the test vacuous.

That last check needed its own reporter, because **the JSON reporter emits `steps: []` for a passing
test** — measured, and it would have left the check permanently unreachable, the same class of flaw as
the mis-scaled classifier weights. The Reporter API does carry those steps, so
`@pwtap/plugin-heal/verify-reporter` is the smallest thing that surfaces them.

And the whole-file check compares against a **baseline of tests that were already failing**. Without
that it refuses every repair made while a sibling is red for an unrelated reason, which is most real
repair sessions; what it must detect is a candidate that _broke_ something.

## Three Playwright capabilities the design rests on, all verified against 1.61

1. **`Reporter.onEnd` may return `{ status }`** — `onEnd?(result): Promise<{status?} | void> | void`.
   That is the quarantine mechanism: no fixture, no `test.fixme()`, no test-file edit.
2. **`TestCase.outcome()` returns `flaky`** and only after the last attempt. There is no such
   `TestResult.status`, so the `onEnd` pass over `allTests()` is not optional.
3. **`Locator.ariaSnapshot({ mode: 'ai' })` is public** — the same snapshot the official healer
   consumes through MCP. Step 5 needs it; no forking, so ADR-002 holds.

## Five corrections the real error strings forced

The taxonomy couples us to someone else's output, so it was built from captured failures rather than
from documentation. Five readings a docs-only design would have got wrong:

| Assumption                                                    | Reality                                                                                                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A presence failure reports `Received: <element(s) not found>` | The not-found variant has **no `Received:` line**; it ends `Error: element(s) not found`. Only the hidden variant reports `Received: hidden` |
| `Locator:` has one space                                      | One **or two**, depending on the longest label in the block                                                                                  |
| An action timeout starts `locator.click: Timeout …`           | It is prefixed `TimeoutError`, and `waiting for` lives in the **call log**                                                                   |
| A test timeout has no error                                   | It does: `Test timeout of 1200ms exceeded.`                                                                                                  |
| A value mismatch has a `Locator:` line                        | A plain `expect(2).toBe(3)` has none, so requiring one would misclassify it                                                                  |

A sixth, found the same way: **each retry runs in a fresh worker process**, so a module-level counter
resets and a "flaky" test built on one never goes flaky. The smoke's flaky spec is file-backed for that
reason.

## Two defects only a real run could produce

- **`FullConfig.rootDir` is the common base directory of the _tests_, not the project root.** With
  `testDir: './tests'` it is `<project>/tests`, so records went to `tests/.heal/runs` and the quarantine
  list was sought in `tests/heal/`. The project root is `dirname(config.configFile)`.
- **`changedFiles` reported "unknown" for a repository with one commit** — which is also every
  `--depth=1` CI checkout, so the diff evidence was being discarded on the majority of real runs. Git
  can still report whether the working tree is dirty, and "nothing is modified" is an answer.

Both were invisible to `tsc`, eslint and the unit tests. The first was invisible even to a live run
until `HEAL_DEBUG` existed, which is why it exists.

## The classifier

**Rule 0 outranks everything: a retry that passed means `flaky`.** A locator that resolved on attempt
two did not change; a value that matched on attempt two is not a regression.

Then, in order: the error taxonomy; cross-run history; and what the diff changed. The weights are
**absolute confidence points**, because the action bands (85 act / 60 advise) are absolute too — an
earlier version treated them as relative nudges and reconciled them with nothing, which left
`locator-drift` unable to reach 85 at all and made the autofix bar decoration.

Confidence is the margin between the leading class and the runner-up, so an ambiguous reading reports
as ambiguous. With no history it is capped at 70: the classifier is reading one run, and saying so is
the difference between evidence and a guess.

`value-mismatch` carries a veto that no score can override.

## Decision log

- **ADR-H1 — Integrate at the reporter, not by forking.** ADR-002 (public APIs only) extends here
  intact: the `onEnd` status override and `ariaSnapshot({mode:'ai'})` are both public, so nothing needs
  patching.
- **ADR-H2 — Advisory first.** Autofix will be restricted to `locator-drift` with an equivalence proof.
  Assertions and expected values are never changed automatically, at any confidence.
- **ADR-H3 — Quarantine via the status override, not `test.fixme()`.** The test still runs, so the
  trace, video and report entry survive. `fixme` leaves no evidence that anything was hidden.
- **ADR-H4 — One package.** Run history has exactly one consumer; splitting it would buy two
  changesets, two semver ranges, a cross-package contract number and a second nfr closure scan for
  zero capability. `src/history/**` imports nothing from `src/heal/**`, so the split stays a `git mv`.
  Trigger to revisit: a second consumer (a dashboard, or Phase 3 reading history directly).
- **ADR-H5 — Zero runtime dependencies.** Argument parsing is twenty lines; `@playwright/test` is a
  peer because the reporter runs inside the client's runner. `nfr-check.mjs` prints the closure of every
  runtime package on every CI run, so a regression is visible on sight.
- **ADR-H6 — `testKey` is ours, not `TestCase.id`.** Playwright documents that as session-unique.
  Project is in the key; `repeatEachIndex` and `retry` are not. A rename produces a new key on purpose:
  renaming a test is an edit, and its flake history is no longer about the same behaviour.
- **ADR-H7 — Two fingerprints.** Site (place + kind) and error (plus values). The split is what lets a
  later phase detect a heal that pointed at the wrong element: "the same site later failed with a value
  mismatch" cannot be expressed if place and values share one hash.
- **ADR-H9 — Candidates come from the error-context snapshot, not from a fixture.** An `auto` fixture
  depending on `page` would launch a browser for every test in every project, API projects included.
- **ADR-H10 — The equivalence proof is graded, and only `proven` may be applied.** An identifier-only
  locator can never be proven; it still gets ranked candidates, because suggesting and proving are
  different acts and conflating them is how a caught bug becomes a green test.
- **ADR-H11 — A structural scope constrains the container's kind.** The class drifted, the tag did not,
  and dropping it let a repeated name be proven against the wrong container.
- **ADR-H12 — Verification uses our own reporter.** The JSON reporter drops steps for passing tests, so
  "did the original assertion still run" is unanswerable through it.
- **ADR-H8 — The reporter fails open, but not silently.** A malformed quarantine file, an unreadable
  record or a bug in our bookkeeping never changes a verdict. `HEAL_DEBUG=1` surfaces what was
  swallowed — a reporter that hides its own errors is undebuggable, which cost real time here.

## Risks

1. **Coupling to Playwright error strings.** Mitigated by one file, a `TAXONOMY_VERSION` that
   participates in both fingerprints (so a bump starts new clusters rather than merging silently), and a
   test that pins every message verbatim so an upgrade breaks our CI first.
2. **The status override is a sharp tool.** Fail open, always; plus the documented `blob` +
   `merge-reports` limitation, with `heal gate` as CI's authoritative exit.
3. **Cross-run history needs CI plumbing this repo has never had** (no `upload-artifact` anywhere).
   Without it, flake rate degrades to within-run only — and the classifier must say so rather than
   pretend, which it does.
4. **The weights are a heuristic tuned on a handful of real failures.** Said plainly. A labelled case
   set and a calibration gate are step 6; until then no threshold should be tightened.

## Verification

```bash
npm run build && npm run lint && npx tsc --noEmit && npm run typecheck:tests
npm test              # 5 new files: errorTaxonomy, fingerprint, triage, flakeStats, runStore,
                      # quarantine, plus create's pwConfig injector
npm run smoke:heal    # a real browser against two fixture versions
npm run nfr           # asserts plugin-heal still declares nothing
```

`smoke-heal.mjs` asserts, in order: a green run records and stays green; a second run keeps the same
`testKey`; v2 breaks the run and triage reads the real error, reaching the act band for the identifier
change; `propose` **refuses to claim proof** for the identifier-only locator while still offering
`getByRole('button', { name: 'Log in' })` among its candidates; `propose` **proves and verifies** the
one case where the code stated two signals, with three greens and the original assertion still running,
and restores the spec afterwards; **the value change is never examined at all**, and the expected value
is still in the file; the flaky spec is never a repair candidate; quarantine suppresses the exit status
while the failure stays in the record; an expired entry turns the run red again; and the gate exits 1
naming the entry, both for an exceeded budget and for a failure nobody quarantined.

The fixture makes those three cases distinguishable on purpose: between v1 and v2 the button loses its
identifiers while keeping its role and name, the greeting's text changes, and a form's wrapper class is
renamed under a role+name locator. A classifier that confuses any two of them has nowhere to hide.

Verified by hand in a real scaffold as well: `create-pwtap add heal` splices the reporter between the
markers, writes the three scripts and copies `docs/HEALING.md`; `remove heal` restores the config and
removes the scripts; and a real run of the scaffolded `api` project recorded four failures classified
`env-infra` from the fixture that reported the missing `API_BASE_URL` — the correct class, for the
correct reason.

## Not in this phase

Assertion or expected-value healing, at any confidence. `test.fixme()` auto-skip. Direct commits. A
database. Forking or patching Playwright. An MCP server. A hosted dashboard. A run-until-green loop.
Healing `api`-project failures — there is no locator concept there, so API failures are triaged only.
Visual-snapshot healing: `toHaveScreenshot` updates are `--update-snapshots`, and wrapping that would
mean taking responsibility for a decision only a human can make.
