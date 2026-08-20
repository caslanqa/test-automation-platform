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

## CI

```yaml
- run: npx playwright test || true
- run: npx heal gate
- run: npx heal triage --json .heal/triage.json
```

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
