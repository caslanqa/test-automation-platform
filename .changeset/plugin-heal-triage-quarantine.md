---
'@pwtap/plugin-heal': minor
'@pwtap/create': minor
---

Failure triage, flake detection and quarantine — advisory by design, and it will not rewrite an assertion

The official Playwright healer is explicitly allowed to update "assertions and expected values" and to
mark a stubborn test `test.fixme()`. Both turn a caught regression into a green suite. This engine
starts from the opposite end: **classify before anything changes**, and never heal a value.

**A typed run model, which this repo did not have.** A custom reporter — the first in this repo —
records every run to `.heal/runs/` as `RunRecord → TestRecord → AttemptRecord → FailureRecord`. It
keys on `TestCase.outcome()`, which is also the fix for a defect in a shipped template:
`plugin-appium`'s `appium-report.mjs` aggregates per _attempt_, so a retried failure is counted once as
`failed` and once as `passed`. Our reporter cannot, and a unit test pins it.

**`outcome() === 'flaky'` is the whole flaky-versus-true-fail distinction, and it is free.** There is no
such `TestResult.status`; it exists only on `TestCase` and only after the last attempt, which is why
the `onEnd` pass over `allTests()` exists. A retry that passed outranks every other signal: a locator
that resolved on attempt two did not change, and a value that matched on attempt two is not a
regression. The official healer has no such rule, which is how it "fixes" a race by rewriting a
selector.

**The taxonomy was captured from real runs, not from docs**, and five of those captures contradicted
what the documentation implied: the not-found variant of a presence failure has no `Received:` line at
all; `Locator:` is padded with one _or_ two spaces; an action timeout is prefixed `TimeoutError` with
`waiting for` living in the call log; a test timeout _does_ produce an error message; and a plain
`expect(2).toBe(3)` has no `Locator:` line, so a value mismatch must not require one.
`errorTaxonomy.test.ts` pins all of them verbatim so a Playwright upgrade breaks our CI rather than a
user's triage.

**Two fingerprints, not one.** `siteFingerprint` answers "same failure, same place"; `errorFingerprint`
adds the observed values. The split is load-bearing beyond tidiness — the strongest signal for a heal
that pointed at the wrong element is "the same site later failed with a value mismatch", which cannot
be expressed if place and values share a hash.

**Quarantine instead of `test.fixme()`.** The reporter can return a status from `onEnd`, so a fully
quarantined failure suppresses the run's exit code **while the test still runs** and its trace, video
and report entry stay intact. `fixme` never executes the test, so it leaves no evidence that anything
was hidden. Entries expire; on expiry the run goes red again and `heal gate` fails naming the entry.
Seven gates back it, including a ratchet that lets the list shrink freely and requires a reason in the
PR for growth — computed from `git show HEAD~1:heal/quarantine.json`, so it needs no store.

**Everything is deterministic and offline.** No model, no browser, no network in triage, history,
quarantine or the gates. An LLM tier is a later, optional escalation for the `unknown` class only, and
it can never move a failure out of `true-fail` or `env-infra`.

Two findings only a real run could produce, both now fixed and covered:

- **`FullConfig.rootDir` is the common base directory of the _tests_, not the project root.** With
  `testDir: './tests'` it is `<project>/tests`, so run records went to `tests/.heal/runs` and the
  quarantine list was looked for in `tests/heal/`. The project root is the config file's directory.
- **`changedFiles` reported "unknown" for a single-commit repository**, which is also every `--depth=1`
  CI checkout — silently discarding the diff evidence on the majority of real runs. Git can still say
  whether the working tree is dirty, and "nothing is modified" is an answer.

`@pwtap/create` gains `PluginManifest.reporter` plus `applyReporter`/`removeReporter`, shaped exactly
like `playwrightProject` so idempotence and add/remove symmetry come from the existing marker
machinery. A new `pwtap:plugins:reporters` region lands in the core template; a project scaffolded
before it exists gets a paste block instead of a half-edit.
