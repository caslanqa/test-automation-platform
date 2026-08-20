# Failure triage, flake detection and quarantine

Every run writes a typed record. Nothing else happens on its own: the reporter records, and you ask.

```bash
npm run heal:triage      # classify the last run
npm run heal:gate        # CI gate — quarantine budget + unshielded failures
npm run heal:quarantine  # what is quarantined, and for how much longer
```

There is no model, no network and no browser in any of that. An agent is a nicer way to read the
output, never a way to reach a verdict the CLI cannot.

## The four classes

| Class           | Meaning                                                                                  | What to do                                         |
| --------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `flaky`         | Same code, same app, non-deterministic outcome                                           | Find the race. Neither outcome is evidence         |
| `locator-drift` | The element is still there and still satisfies the test's intent; its identifier changed | Repoint the locator — with proof                   |
| `true-fail`     | The application's behaviour or data changed                                              | **Report it. Do not touch the test**               |
| `env-infra`     | Harness, network, dependency or browser failed                                           | Re-run the job; fix the infrastructure             |
| `unknown`       | Evidence insufficient                                                                    | Read the trace. A guess here becomes a code change |

### A value mismatch is never healed

If `Expected: "Welcome, Ada"` meets `Received: "Welcome, Grace"`, the test is doing its job. That
reads as `true-fail` and carries a veto no confidence score can override. Changing the expected value
would make the suite green and the bug invisible, which is the single most damaging edit available in
a test suite — and it is exactly what a heal-until-green loop does.

### A retry that passed outranks everything

`retries` is `2` on CI by default. A test that failed and then passed in the same run is Playwright's
own `flaky` outcome, and this engine treats it as conclusive: a locator that resolved on the second
attempt did not change, and a value that matched on the second attempt is not a regression. So a race
is never mistaken for drift.

Locally `retries` is `0`, so that signal does not exist. Triage says so rather than pretending, and
caps its confidence accordingly.

## What the confidence means

| Band   | Range | Meaning                     |
| ------ | ----- | --------------------------- |
| act    | ≥ 85  | Strong enough to act on     |
| advise | 60–84 | A human decides             |
| ask    | < 60  | Report only; read the trace |

Confidence is the **margin** between the leading class and the runner-up, so a 40-vs-38 reading
reports as the close call it is. With no cross-run history the classifier cannot exceed 70: it is
reading one run, and saying so is the difference between evidence and a guess.

## Proposing a repair

```bash
npx heal propose              # rank replacements, try to prove one, verify it, write a proposal
npx heal propose --no-verify  # skip the reruns
npx heal propose --apply      # write the edit — only ever for a PROVEN, verified candidate
```

Only `locator-drift` is examined. A `true-fail` is not "refused after consideration" — it never
becomes a candidate at all, which is a stronger guarantee than a late veto.

The candidates come from the **ARIA snapshot Playwright already captured at the failure** (the
`error-context` attachment), so nothing re-runs your suite to look at the page. That snapshot carries
roles, accessible names, properties like `/placeholder`, and the nesting that gives each element its
landmark path. It cannot see test ids or classes — which costs nothing, because a drifted locator has
lost its identifier by definition.

### Is it the same element?

A replacement that resolves and makes the assertion pass has proved nothing: it may be a _different_
element that happens to satisfy the check. So the verdict depends on what your code stated about the
element, and only the strongest verdict is ever applied.

| Verdict   | When                                                                                                 | Applied?                |
| --------- | ---------------------------------------------------------------------------------------------------- | ----------------------- |
| `proven`  | two of the locator's signals (role, name) match, the candidate is unique, and any stated scope holds | eligible with `--apply` |
| `likely`  | one signal matches and that name is unique page-wide                                                 | advisory only           |
| `moved`   | the signals match but the candidate is outside the container the locator named                       | advisory only           |
| `refused` | nothing shared to check against, not unique, or below the score floor                                | never                   |

**`getByTestId('submit')` and `locator('#login-button')` can never be proven.** They state one thing,
and that thing is exactly what vanished — nothing in the code says the element was a button labelled
"Log in". You still get the ranked candidates, because that list is what a human would have written
out by hand; what you do not get is a claim that any of them was verified to be the same element.

A structural scope still constrains the _kind_ of container: `locator('form.signin').getByRole(…)`
requires the replacement to be inside a `form`. Without that guard, a name repeated in a form and a
dialog could be "proven" against the wrong one.

### Verification

Before anything is applied, the candidate is run:

- three consecutive greens with **`--retries=0`** and `--workers=1` — a heal validated by a retry is
  not validated, and one green proves nothing about order or timing (`HEAL_GREENS` to change it);
- then the whole file at the configured concurrency, to catch order dependence;
- and the matcher that originally failed must appear as a step in a green attempt, or the replacement
  may have made the test vacuous.

A sibling that was **already** failing is not held against the candidate. Only tests that were
passing before the edit and fail after it count as broken by it.

The spec is restored after a verification run unless `--apply` was given and everything held, so a
failed verification never leaves an edit nobody approved.

### What a proposal looks like

`.heal/proposals/<testKey>-<n>/` holds `report.md` (start here), `provenance.json` (the machine-readable
record: triage, from, to, proof, verification, every candidate considered, and every check that passed
or refused) and `patch.diff` when there is an edit to make.

## Flake history that outlives an artifact

`.heal/runs/` is gitignored and machine-local, and in CI it survives only as an artifact — retention is
90 days by default and one day on some plans. A flake rate has to outlast that.

```bash
npm run heal:baseline -- --update    # fold the runs into heal/flake-baseline.json, committed
```

The fold is additive and **idempotent**: every run is recorded by id, so re-running the job, or running
it on two machines that each saw part of the history, adds each run exactly once.

Committing the aggregate rather than the runs keeps the file small, readable and blameable — and buys
the thing no store would: `git log -p heal/flake-baseline.json` answers "when did this test start
flaking" with no database at all.

Without it the classifier has no cross-run history. It says so rather than guessing — it names the gap
and caps its confidence at 70, below the act band — but a healer that cannot tell a race from a
regression is the failure mode this plugin exists to avoid.

## Run history

Records land in `.heal/runs/` (gitignored), newest 50 kept. That is where a flake rate comes from, so
a fresh checkout has no history and triage will tell you.

On CI the directory is ephemeral unless the workflow uploads it. Without that, flake rate degrades to
within-run only — which is a real limitation, stated rather than hidden.

**A CLI `--reporter` flag replaces the configured reporter array**, so
`npx playwright test --reporter=line` silently records nothing. Use `--reporter` only when you mean to
turn recording off.

## Quarantine

`heal/quarantine.json` is **committed**: it is policy, and it belongs in review and in `git blame`.

```json
{
  "version": 1,
  "entries": [
    {
      "testKey": "9f2a1c04e5b6d7a8",
      "project": "chromium",
      "file": "tests/cart.spec.ts",
      "title": "cart › updates the badge",
      "class": "flaky",
      "reason": "races with the badge animation on a cold cache",
      "addedAt": "2026-08-18T09:00:00.000Z",
      "expiresAt": "2026-09-01T09:00:00.000Z",
      "addedBy": "ada@example.com",
      "issue": "https://github.com/acme/app/issues/4412",
      "evidence": { "flakeRate": 0.3, "runs": 20 }
    }
  ]
}
```

Only `flaky` and `env-infra` may be quarantined. Quarantining a `true-fail` hides a bug; quarantining
a `locator-drift` hides a fix you could have made.

**A quarantined test still runs.** Every attempt executes and the failure stays in the HTML, JSON and
Allure reports with its trace and video — only the run's exit status is suppressed. That is the whole
reason this exists instead of `test.fixme()`, which never executes the test and so leaves no evidence
that anything was hidden.

Entries expire. On expiry the run goes red again **and** the gate fails naming the entry. There is no
silent renewal: renewing is a commit with a reason, which is the point.

### The gates

`heal gate` exits 1 on any of these:

| Gate            | Default          | What it protects against                                    |
| --------------- | ---------------- | ----------------------------------------------------------- |
| `expired`       | —                | Quarantine as a permanent graveyard                         |
| `max-entries`   | 5                | Quarantine as the flake strategy                            |
| `max-share`     | 2% of the suite  | The same, for large suites                                  |
| `max-ttl`       | 30 days          | TTL laundering                                              |
| `missing-issue` | after 7 days     | Quarantining instead of filing                              |
| `weak-evidence` | 0.2 over 10 runs | A deterministic failure wearing the word flaky              |
| `ratchet`       | any growth       | The list may shrink freely; growth needs a reason in the PR |

Plus the other half: a failing run whose failures are not **all** quarantined fails the gate.

## Was the healing any good?

`heal metrics` answers it from `heal/heal-log.jsonl` — the committed, append-only record of every heal
that was applied. Append-only is the point: a heal that turns out to have hidden a bug is the most
important line in the file, and a format that let it be edited away would make the one metric that
matters unauditable.

```bash
npm run heal:metrics    # precision, mask rate, quarantine shape, flake-rate direction
```

| Metric             | What it says                                                       | Gated                                             |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------------- |
| `precision`        | Heals whose site stopped failing, over the ten runs after each one | at 0.9, and only once 10 heals exist              |
| **`maskRate`**     | Heals that may have hidden something                               | **at zero**                                       |
| `recall`           | Applied over drift-shaped failures                                 | **never** — the denominator is our own classifier |
| `medianTimeToHeal` | First failure to repair                                            | no                                                |
| `flakeRateTrend`   | Recent flake rate against the window before it                     | no                                                |

**The mask rate is the number that matters**, because one masked bug costs more than every heal ever
saved. It is detected three ways and the report labels each:

1. `reverted-as-masking` — **ground truth**. A human ran `heal revert <id> --reason masked-bug`.
2. `value-mismatch-at-the-healed-line` — heuristic, and the strongest one available. The same test
   later failed a _value_ assertion at the exact line a heal edited, which is what pointing at the
   wrong element looks like from the outside.
3. `heal-no-longer-in-place` — heuristic. The locator the heal wrote is no longer in the spec, so
   somebody took it back out.

A heuristic is not a finding. Read each one and record what it actually was:

```bash
heal revert 9f2c1a --reason masked-bug --note "the button was disabled, not moved"
```

`heal revert` records; it does not touch your code. Undoing the edit is `git revert`, which is better
at it — what git cannot do is tell the metrics _why_ it was undone.

### Grading the classifier

`heal/triage-cases.json` is a labelled set of failures and the class a human says each one is. The
plugin ships a starter set; grow it from your own failures:

```bash
npx heal calibrate --harvest    # draft cases from the recorded runs, uncertainty first
npm run heal:calibrate          # grade — offline: no model, no browser, no network
```

A drafted case's `expected` is the classifier's own answer. **Review and correct each one** — a case
that agrees by construction grades nothing.

| Gate                     | Default | What it protects                                                               |
| ------------------------ | ------- | ------------------------------------------------------------------------------ |
| `--min-accuracy`         | 85      | Five classes with a real `unknown` base rate; 90 on a small set gates on noise |
| `--min-kappa`            | 0.7     | "Substantial" on Landis-Koch. Accuracy alone is inflated by the dominant class |
| **`--max-false-heal`**   | **0**   | A regression classified as repairable is how a green suite becomes a lie       |
| **`--max-missing-veto`** | **0**   | The class is advice; the veto is what actually blocks a repair                 |

`falseBug` — the opposite mistake — is reported and deliberately **not** gated. Over-reporting a
regression is noisy, not dangerous, and gating both directions equally would push the classifier
toward repairing more.

A case may demand a veto as well as a class, and several of the shipped ones do. When a human has just
edited the failing spec, the evidence still reads as drift and the classifier still says so — what
stops a repair is `test-file-edited`, not the label. Grading only the label would let a refactor drop
that guard while calibration stayed green.

## CI

```yaml
- run: npx playwright test || true
- run: npx heal gate
- run: npx heal triage --json .heal/triage.json
```

Two workflows are copied into `.github/workflows/` on install, once, and never overwritten:

- **`heal-calibration.yml`** — nightly. Grades the classifier against your cases and measures the
  applied heals. Offline, so it costs nothing and cannot be blocked by a provider outage.
- **`heal-history.yml`** — nightly. Folds the run records CI produced into `heal/flake-baseline.json`
  and opens a pull request. See below.

Both skip with a `::notice::` rather than failing red until there is something for them to read.

Two things worth knowing about the exit status:

- The reporter can suppress a run's exit status for a fully-quarantined failure. Under `--shard` with
  the `blob` reporter and `merge-reports`, that suppression only applies if the heal reporter is also
  configured in the merge step. **`heal gate` is CI's authoritative gate**; the reporter override is
  the ergonomic local path.
- The reporter **fails open**. A malformed quarantine file, an unreadable record or a bug in our own
  bookkeeping never changes a verdict — it disables shielding and says so on stderr. Set `HEAL_DEBUG=1`
  to see anything that was swallowed.

## How this differs from `playwright init-agents --loop`

Four things, and each one is asserted in CI rather than claimed here:

1. **Flaky versus true-fail.** A retry that passed is conclusive evidence of intermittency, and
   nothing downstream may treat it as drift.
2. **Assertions are never rewritten.** The official healer is explicitly allowed to update "assertions
   and expected values", which turns a caught regression into a passing test.
3. **No silent `test.fixme()`.** Quarantine keeps the test running and its evidence intact, expires,
   and is budgeted.
4. **History, not one run.** A classification made from a single run says so and refuses to reach the
   act band.
