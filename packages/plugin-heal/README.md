# @pwtap/plugin-heal

Failure triage, flake detection and locator healing for the [Playwright Test Automation Platform](https://www.npmjs.com/package/@pwtap/create) — it classifies a red run before it changes anything, and it will not rewrite an assertion.

[![npm](https://img.shields.io/npm/v/@pwtap/plugin-heal)](https://www.npmjs.com/package/@pwtap/plugin-heal)

## Install

```bash
npx @pwtap/create add heal
```

That splices one reporter into `playwright.config.ts`, adds seven scripts, copies a starter case set to
`heal/triage-cases.json` and two nightly workflows to `.github/workflows/`. `remove heal` undoes all of it.

Zero runtime dependencies. No model, no network, no browser in triage — the only browser work is the
verification re-run, using the Playwright you already have.

## Adopt it in this order

Reading triage costs nothing and teaches you whether to trust it. Applying a repair costs a code change.
Do them in that order.

| Week | Do                                                                                   | Why                                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `heal:triage` only. Never run `propose`                                              | Read the classifications against failures you already understand. If a class looks wrong, that is the signal — not a reason to skip ahead       |
| 2    | `heal:gate` in CI, and quarantine a genuinely flaky test                             | The gate is the highest-value line here: it fails a build for an unshielded failure or a quarantine that has outstayed its welcome              |
| 3    | `heal calibrate --harvest`, correct the labels, then `heal:calibrate` in the nightly | The 16 shipped cases are a starting point, not your suite. This is where the classifier stops being our guess and starts being your measurement |
| 4    | `heal:propose`, read the proposals, and only then `--apply`                          | By now you know what the engine refuses and why, which is the only basis on which to let it change a file                                       |

Skipping week 3 is the one that hurts: you would be running a classifier tuned to our examples rather than
your failures, and the gates would be measuring nothing.

## The loop

```bash
npx playwright test          # the reporter records every run to .heal/runs/
npm run heal:triage          # classify what failed
```

```text
[heal] 3 failure(s) in the run started 2026-08-21T09:12:44.019Z:

  → locator-drift  (90, act)  [chromium] checkout › the pay button submits
      tests/checkout.spec.ts:41
      · the error is strict-mode
      · nothing in the repository changed, so the application moved

  ✗ true-fail  (85, act)  [chromium] cart › the badge counts items
      tests/cart.spec.ts:18
      · the error is value-mismatch
      no autofix: value-mismatch: the expected value is the test doing its job

  ~ flaky  (95, act)  [chromium] search › results appear
      tests/search.spec.ts:9
      · it passed on a retry, so the code and the application did not change

[heal] 1 of these look like real regressions. Do not change the expected values — report them.
```

Then, per class:

| Class           | What it means                                                     | Do                                          |
| --------------- | ----------------------------------------------------------------- | ------------------------------------------- |
| `locator-drift` | The element is still there; its identifier changed                | `npm run heal:propose`                      |
| `true-fail`     | The application behaves differently than asserted                 | Nothing automatic. It is a bug              |
| `flaky`         | Same code, same app, non-deterministic result                     | Measure it, then quarantine or fix the wait |
| `env-infra`     | The harness broke — refused connection, dead browser, bad fixture | Re-run the job                              |
| `unknown`       | The evidence does not distinguish these                           | Read it yourself                            |

## `flaky` versus `true-fail` is free, and nothing else gets it right

`TestCase.outcome() === 'flaky'` exists only after the last attempt, and it outranks every other signal: a
locator that resolved on attempt two did not change, and a value that matched on attempt two is not a
regression. Playwright's own healing agent has no such rule, which is how it "fixes" a race by rewriting a
selector.

With `retries: 0` there is no in-run signal at all, so measure it instead of guessing — and note that this
plugin deliberately does **not** raise your `retries` to manufacture one:

```text
$ npx heal triage --confirm-flake 9f2a1c04e5b6d7a8 --runs 5
[heal] running 'results appear' 5× with retries off…
[heal] 2 passed, 3 failed over 5 separate runs — flaky.
[heal] Measured, not inferred. This is quarantine-eligible evidence: `heal quarantine add` will take it.
```

The other two answers are as useful: `consistent-fail` means it is not a flake at all (and prints the
first failure's output, because "it fails every time" without a reason sends you back to run it yourself),
and `consistent-pass` means the failure needs the rest of the suite — order or shared state, not the test.

Separate processes, not `--repeat-each`: module state persists inside one process, and module state is
exactly what a first-run-only failure is made of.

## Repairing a locator — and refusing to

```bash
npm run heal:propose               # rank, prove, verify. Writes nothing
npm run heal:propose -- --apply    # only with a proven proof AND a passing verification
```

```text
  → ready  checkout › the pay button submits
      locator('#pay-btn')  →  getByRole('button', { name: 'Pay now' })
      equivalence: proven, greens 3
      .heal/proposals/9f4126f78b8a8fec-1

  · checkout › the promo field accepts a code
      locator('.promo input')  →  getByPlaceholder('Promo code')
      equivalence: refused
      refused: no-shared-signal: the locator only stated a class, and that class is gone
      .heal/proposals/1c2d3e4f5a6b7c8d-2

  · cart › the badge counts items
      not examined — true-fail: only locator-drift is ever repaired — a changed value is the test
      doing its job, and rewriting it would hide the bug
```

Candidates come from the ARIA snapshot **Playwright already wrote** at the moment of failure (the
`error-context` attachment) — no fixture, no probe run, no second browser. The equivalence verdict is
graded and only `proven` may ever be applied:

| Verdict   | Meaning                                                                                  |
| --------- | ---------------------------------------------------------------------------------------- |
| `proven`  | Two independent signals agree, the replacement is unique, the neighbourhood is unchanged |
| `likely`  | Unique and agreeing, but not enough signals to be sure                                   |
| `moved`   | The same element, in a different container — usually an intentional redesign             |
| `refused` | Nothing can be shown to be the same element                                              |

`locator('#login-button')` states one thing, and that one thing is gone, so nothing can be proven about a
replacement. It gets ranked candidates and a refusal, because suggesting and proving are different acts.

Verification is three consecutive greens with `--retries=0` under `--workers=1`, then the whole file at the
configured concurrency — **and** the matcher that originally failed must reappear as a passing step, or the
"repair" made the test vacuous.

**A value mismatch is never healed.** If `Expected: "Welcome, Ada"` meets `Received: "Welcome, Grace"`, the
test is doing its job. That is asserted in CI against a real browser, not argued for in a document.

## Quarantine, not `test.fixme()`

```bash
npm run heal:quarantine
```

A quarantined test **still runs**. Its trace, video and report entry are all there; the reporter only
suppresses the run's exit status:

```text
[heal] 2 quarantined failure(s) did not fail the run:
  ✗ shows an error for a bad password  (flaky, expires in 6 days, #4412)
  ✗ updates the badge  (flaky, expires in 2 days — NO ISSUE)
  Quarantine: 2 entries. `npx heal gate` enforces the budget.
```

`test.fixme()` never executes the test, so it leaves no evidence anything was hidden. Entries expire; on
expiry the run goes red again and the gate fails naming them. Only `flaky` and `env-infra` may be
quarantined — hiding a `true-fail` hides a bug, and hiding a `locator-drift` hides a fix you could make.

## CI

```yaml
- run: npx playwright test || true
- run: npx heal gate # exit 1 on a quarantine violation or an unshielded failure
- run: npx heal triage --json .heal/triage.json
- uses: actions/upload-artifact@v4
  with:
    name: heal-runs-${{ github.job }}
    path: .heal/runs
```

**`heal gate` is CI's authoritative gate.** The reporter's exit-status override does not apply under
`--shard` with `blob` + `merge-reports` unless the heal reporter is configured in the merge step too. The
gate has no such caveat.

Seven gates back it, including a ratchet computed from `git show HEAD~1:heal/quarantine.json` — the list may
shrink freely, and growth needs a reason in the pull request. No store required.

## Was the healing any good?

```bash
npm run heal:metrics
```

| Metric                                                         | Gated at                                          |
| -------------------------------------------------------------- | ------------------------------------------------- |
| **`maskRate`** — heals that may have hidden something          | **0**                                             |
| `precision` — heals whose site stopped failing                 | 0.9, and only past 10 applied heals               |
| `recall` — applied over drift-shaped failures                  | **never** — its denominator is our own classifier |
| `flakeRateTrend` — recent flake rate against the window before | no                                                |

The mask rate is the number that matters, because one masked bug costs more than every heal ever saved. It
is detected three ways and the report labels each — two heuristics and one ground truth:

```bash
heal revert 9f2c1a --reason masked-bug --note "the button was disabled, not moved"
```

That records; it does not touch your code. Undoing the edit is `git revert`, which is better at it — what
git cannot do is say _why_.

## Grade the classifier against your own failures

```bash
npx heal calibrate --harvest     # draft cases from real runs, least-certain first
npm run heal:calibrate           # offline: no model, no browser, no network
```

```text
[heal] 16/16 correct — accuracy 100.0%
       kappa 1.000 (almost perfect) — the gate that actually protects.
       false heals 0  ·  false bugs 0  ·  lost vetoes 0

       class            expected  classified  correct
       env-infra              4           4        4
       flaky                  3           3        3
       locator-drift          6           6        6
       true-fail              2           2        2
       unknown                1           1        1

[heal] calibration ok.
```

Sixteen starter cases ship with the plugin and a test asserts they pass their own gates. **Replace them with
yours.** A drafted case's `expected` is the classifier's own answer; review and correct each one, because a
case that agrees by construction grades nothing.

`--max-false-heal` and `--max-missing-veto` are both **0**: calling a regression repairable is how a green
suite becomes a lie, and the class is only advice — the veto is what actually blocks a repair.

## Flake history that outlives an artifact

`.heal/runs/` is gitignored and machine-local; in CI it survives only as an artifact, and retention is 90
days by default and one day on some plans.

```bash
npm run heal:baseline -- --update    # folds runs into heal/flake-baseline.json, committed
```

Additive and idempotent — every run is recorded by id, so re-running it, or running it on two machines that
each saw part of the history, adds each run exactly once. Committing the aggregate buys what no store
would: `git log -p heal/flake-baseline.json` answers "when did this test start flaking".

## Mobile

An Appium or Maestro suite gets all of the above unchanged — the seam is Playwright's reporter, not the
browser. Three kinds exist only there, and all three say _the locator was right_: `stale-element`,
`not-interactable`, `driver-unsupported`.

`@pwtap/mobile-core` captures the element tree into a `mobile-hierarchy` attachment when a mobile test
fails, which is what makes mobile repair possible with no device. Two extra refusals: never heal to a
coordinate, never heal through an out-of-app warning. A mobile proposal is always advisory — verifying one
means re-running on the device that produced the failure.

## When the evidence is not enough (optional, off by default)

```bash
export HEAL_MODEL=groq/llama-3.3-70b     # or reuse JUDGE_MODEL — no new key needed
npm run heal:triage -- --escalate
```

Only failures that stayed `unknown` are ever escalated. Four rules live in **code**, not in the prompt,
because the material being classified contains the tested page's own text:

1. A deterministic class other than `unknown` is never overridden.
2. The answer is intersected with the classes the evidence leaves open — a value mismatch removes
   `locator-drift` from that set entirely.
3. Confidence is capped at **84**. The floor for acting is 85.
4. A split panel is `unknown`.

Together: **a model here can never authorise a code change.** The CI smoke asserts it against a gateway
that answers `locator-drift` to everything.

Requires `@pwtap/plugin-ai-judge` (an optional peer, for its transport). Without it, or with no model
configured, nothing changes: no import, no network, and every exit code, gate and quarantine decision is
identical.

## How this differs from `playwright init-agents --loop`

Four things, each asserted in CI rather than claimed here:

1. **Flaky versus true-fail.** A retry that passed is conclusive, and nothing downstream may treat it as
   drift.
2. **Assertions are never rewritten.** The official healer is explicitly allowed to update "assertions and
   expected values", which turns a caught regression into a passing test.
3. **No silent `test.fixme()`.** Quarantine keeps the test running and its evidence intact, expires, and is
   budgeted.
4. **History, not one run.** A classification made from a single run says so and refuses to reach the act
   band.

## Full guide

`docs/HEALING.md` — the class definitions, the complete refusal list, quarantine policy, the metrics and
their gates, and what this plugin deliberately does not do.

## Requirements

- Peer: `@playwright/test >= 1.61`. Node ≥ 22.23.
- Optional peers: `@pwtap/plugin-ai-judge` (escalation), `@pwtap/mobile-core` (mobile repair). Both absent
  by default and both fully optional.

## License

MIT
