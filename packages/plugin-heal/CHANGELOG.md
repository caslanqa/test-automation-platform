# @pwtap/plugin-heal

## 1.0.0

### Minor Changes

- 0de9997: Failure triage, flake detection and quarantine — advisory by design, and it will not rewrite an assertion

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

  **Locator repair, and the reason it refuses more than it applies.** `heal propose` ranks replacement
  locators, tries to prove one is the same element, runs it, and writes a reviewable proposal. Nothing is
  written to a spec without `--apply` **and** a proven proof.

  The candidates come from an ARIA snapshot **Playwright already captured at the failure** — the
  `error-context` attachment, whose path the reporter was already recording. That is the same perception
  the official healer gets through an MCP `browser_snapshot`, for free. The alternative the plan called
  for, an auto-fixture that captures the page on teardown, would have had to depend on `page`, and an
  `auto: true` fixture's dependencies are always instantiated — so every test in every project would have
  launched a browser, API projects included.

  **The plan contradicted itself here and the contradiction mattered.** It asked for a binary "two
  independent signals or refuse" while also expecting `locator('#login-button')` to be auto-repaired into
  `getByRole('button', { name: 'Log in' })`. Both cannot hold: that locator states one thing, and nothing
  in the code says the element was a button labelled "Log in". The verdict is therefore graded — `proven`,
  `likely`, `moved`, `refused` — and only `proven` may ever be applied. An identifier-only locator lands
  on `refused` with the ranked candidates still attached, because suggesting and proving are different
  acts and conflating them is exactly how a caught bug becomes a green test.

  A test caught a real safety hole while this was being built: with the same name in two containers, the
  ranking led with the wrong one and role+name then "proved" it — a `Continue` button in a dialog proven
  for a locator scoped to `form.signin`. A structural scope cannot constrain the class (that is what
  drifted) but it does constrain the kind of container, so the replacement must now be inside a `form`.

  Verification is three consecutive greens with `--retries=0` under `--workers=1`, then the whole file at
  the configured concurrency, and the matcher that failed must reappear as a step in a green attempt or
  the replacement may have made the test vacuous. Two measured details shaped that: **the JSON reporter
  emits `steps: []` for a passing test**, so the assertion check would have been permanently unreachable
  through it and needed its own reporter; and the whole-file check compares against the tests that were
  _already_ failing, because otherwise it refuses every repair made while a sibling is red for an
  unrelated reason — which is most real repair sessions.

  **Measuring the healing, and gating the one number that matters.** `heal metrics` reads
  `heal/heal-log.jsonl` — committed, append-only, one line per applied heal. Append-only is the design,
  not tidiness: a heal that turns out to have hidden a bug is the most important line in the file, and a
  format that let it be edited away would make the only metric worth having unauditable.

  Precision is reported but **undefined below ten applied heals**, because without that floor one unlucky
  heal fails the nightly forever. Recall is reported and never gated — its denominator is our own
  classifier, so early on it measures our optimism rather than reality, and gating it would push the
  engine toward repairing more. The mask rate is gated at zero.

  **The plan's second mask detector could not have worked, and the failure would have been silent.** It
  asked for "the same `siteFingerprint` later failed with a value mismatch". The site fingerprint includes
  the locator code and healing changes exactly that, so a post-heal failure necessarily carries a
  different fingerprint: the detector would have been permanently dark while reading correctly in review.
  What replaced it is the same test failing with `kind === 'value-mismatch'` at the same file and **line**
  the heal edited — the observable form of "we repointed a locator and an assertion there began to
  disagree". A test pins both directions: it fires at the healed line and stays silent one line away.

  **The third detector was wrong twice, and the smoke caught the first one immediately.** Asking git for
  the history of the healed line flags every committed repair, because the commit that lands a heal is
  itself a commit after it — and the comparison used git's offset-bearing `%aI` against an ISO `Z`
  timestamp as strings, which makes every commit in a non-UTC timezone look later than it was. It now
  asks the question directly: is the locator the heal wrote still in the spec? No clock, no repository,
  and robust to the line moving.

  **A defect the same step exposed in the reporter.** Playwright clears the output directory at the start
  of every run, so the ARIA snapshot a failure captured is deleted by the next one — including the
  verification run `heal propose` performs. A second `propose` against the same record therefore found no
  evidence, and, worse, uploading `.heal/runs` as a CI artifact would have shipped records pointing into a
  `test-results/` directory that was not in the artifact. The reporter now copies the `error-context`
  attachment next to the run record and points the record at the copy, which makes a record
  self-contained; `pruneRuns` removes the copies with the record they belong to.

  **`heal calibrate` grades the classifier against labelled cases, entirely offline** — no model, no
  browser, no network, no run of the suite, because a gate that needs the world to be reachable is a gate
  that gets disabled. Sixteen starter cases ship with the plugin and a test asserts they pass their own
  thresholds, since that file is what the nightly workflow runs on the first night of every project that
  installs this. `kappaMulti` generalises `plugin-ai-judge`'s binary `kappa` to five classes, and a test
  asserts the two agree on two-class input so the generalisation cannot quietly drift into meaning
  something else.

  **Three of those sixteen cases exposed a real gap, and the tempting fix was the wrong one.** The
  diff-correlation rules were given small nudges toward `true-fail` when the weights were still relative;
  after they were rescaled to absolute confidence points, a `presence-timeout` contributes 60 to
  `locator-drift` and a +25 nudge can no longer change the winner. Raising the nudges would have produced
  the label `true-fail` — but that label is a claim about the _application_, and when a human has just
  edited the spec the application did not change. What actually protects the repository in all three cases
  is the veto (`test-file-edited`, `source-edited`, `never-passed`), and `heal propose` turns every veto
  into a refusal. So the classifier was left alone and the dataset was extended instead: a case may now
  demand vetoes as well as a class, and `missingVeto` is gated at zero next to `falseHeal`. Grading only
  the label would have let a refactor drop a guard while calibration stayed green.

  `falseBug` — over-reporting a regression — is reported and deliberately not gated. It is noisy, not
  dangerous, and gating both directions equally would push the classifier toward repairing more.

  **Flake history that outlives an artifact.** `.heal/runs/` is gitignored and machine-local; in CI it
  survives only as an artifact, and retention is 90 days by default and one day on some plans. So
  `heal baseline --update` folds runs into per-test counters in `heal/flake-baseline.json`, committed. The
  fold records each run by id, which makes it idempotent across the overlapping artifact downloads a
  nightly job actually performs — without that, re-running the job would double every counter and a
  doubled flake rate is a quarantine nobody needed. Committing the aggregate rather than the runs also
  buys what no store would: `git log -p heal/flake-baseline.json` answers "when did this test start
  flaking".

  Two nightly workflows are copied in on install and never overwritten, both skipping with a `::notice::`
  rather than failing red until there is something to read: `heal-calibration.yml` grades the classifier
  and measures the applied heals, and `heal-history.yml` folds the runs and opens a pull request with the
  new counters. A counter change that lands without review is a quarantine decision nobody made.

  **An optional escalation tier, and the four rules that make it safe.** `heal triage --escalate` can ask
  a model about the failures the deterministic classifier left as `unknown` — a bare
  `Test timeout of 30000ms exceeded.` with no history says almost nothing, and that is the case this
  exists for. It is off by default, it requires `@pwtap/plugin-ai-judge` as an optional peer, and with no
  model configured nothing changes: no import, no network, no message per failure, and every exit code,
  gate and quarantine decision identical.

  The material being classified contains the tested page's own text, so **the rules are in code, not in
  the prompt**: a deterministic class other than `unknown` is never overridden; the answer is intersected
  with the classes the evidence leaves open, and every repair-blocking veto removes `locator-drift` from
  that set; confidence is capped at 84, one below the act band; and a split panel is `unknown`, because
  judges disagreeing is not evidence. Together, **a model in this system can never authorise a code
  change** — asserted by unit tests that attack each rule individually and by a smoke against a gateway
  that answers `locator-drift` to every question. The regression's class does not move, and the model is
  never even asked about it.

  The page's message, call log, expected/received values and locator are quoted inside `<material-NONCE>`
  with a fresh nonce per call — the same discipline `judgePrompt.ts` uses for a chatbot response, for the
  same threat — and the reply is validated against the closed five-class set before anything reads it.

  **The plan was wrong about one thing, and the correction improved the seam.** It expected a provider
  registered through `registerProvider` to serve the healer automatically. It cannot: `AIProvider.judge`
  returns a `JudgeVerdict`, and a failure class is not one — the same reason Anthropic could not be reached
  that way without pulling `@anthropic-ai/sdk` into every heal installation. So `@pwtap/plugin-ai-judge`
  now exports its transport and routing (`judgeFetch`, `judgeTimeoutMs`, `kindForModel`, `stripPrefix`,
  `extractJsonObject`) plus a new `endpointForKind`, and the healer composes the three wire formats itself.
  Exposing the endpoint table rather than copying four gateway URLs is both the lazier and the safer
  choice: a second copy drifts, and a drifted base URL is a confusing 404 for whoever configured `groq/…`.
  A custom provider now serves the healer as well, by passing an `endpoint` alongside itself.

  `HEAL_MODEL` falls back to `JUDGE_MODEL`, so a project that already configured the judge gets this with
  zero new environment keys. A failed call is deliberately not counted as a vote — one unreachable
  endpoint must not manufacture the tie that suppresses a real majority.

  **Mobile, and the discovery that made it testable.** An Appium or Maestro suite now gets the whole
  engine: run history, `testKey`, both fingerprints, quarantine, the gates, the metrics and the
  calibration are shared unchanged, because the seam is Playwright's reporter rather than the browser. A
  mobile "element not found" is classified by the **same** `presence-timeout` kind a web one is, which is
  what parity actually means here.

  The plan called for a post-run probe against a booted device. That cannot run in CI — and the
  consequence it did not name is that none of mobile repair could have been tested, so every refusal in it
  would have been a claim rather than an assertion. Instead `@pwtap/mobile-core` captures the element tree
  into a `mobile-hierarchy` attachment when a test fails, and mobile repair becomes the same shape as web
  repair: read a file the run left behind. Thirty-eight new tests, none needing a device.

  The error vocabulary was taken from installed sources rather than invented, and **each pattern names
  where it came from** — `webdriver@9.30.0` for the three "element not found" shapes, the `WebDriverError:`
  wrapper, the invalid-selector rewrite and the stale-element name; this repo's own adapters for the rest.
  An Appium upgrade that changes a message now breaks our CI loudly instead of silently reclassifying
  every mobile failure in a user's project.

  Three corrections the real sources forced. Every mobile failure arrives wrapped as
  `[mobile-inspector] "tap" failed: <driver message>`, so patterns written against the bare message would
  have matched nothing in production while passing any unit test that skipped the wrapper. `does not
support` was too loose for a capability gap — it also matches a driver message containing the phrase, and
  reading a missing element as a capability gap tells a human to change the test when the app had moved. And
  `element not interactable` is not a presence timeout but its opposite: the locator **resolved**, so a
  repair would repoint a correct locator at some other element that happens to be tappable. It,
  `stale-element` and `driver-unsupported` each carry a veto saying so, which also removes `locator-drift`
  from the escalation tier's candidate set.

  Two mobile-only refusals: never heal to a coordinate (it passes today and taps empty space after any
  layout change) and never heal through an out-of-app warning (that locator cannot resolve on replay at
  all). A mobile proposal is **always advisory** — verifying one means re-running on the device that
  produced the failure, which this process cannot assume is attached, so `--apply` refuses it and says why.

  The plan's `./heal` subpath on `@pwtap/mobile-core` was dropped: everything the mobile target needs is
  already public on its main entry, so the subpath would have added a versioned cross-package contract for
  zero capability, in the direction the plan itself forbids. The target lives here behind an optional peer.

  **`heal triage --confirm-flake <testKey>`** measures flakiness instead of inferring it. The strongest
  signal is a retry that passed, and the core scaffold sets `retries: 0` locally — so there is none. The
  manifest deliberately does not raise `retries`: that is the user's config, and doubling local wall-clock
  for a diagnostic is not our decision. The probe runs the test N times in **separate processes** with
  retries off, because `--repeat-each` keeps module state alive and module state is exactly what a
  first-run-only failure is made of. A `consistent-fail` prints the first failure's output, since "it fails
  every time" without a reason sends the reader back to run it themselves.

  `TAXONOMY_VERSION` moves to 2 for the three new kinds. It participates in both fingerprints, so existing
  history starts new clusters rather than silently merging with the old ones — which is the behaviour that
  version exists for.

### Patch Changes

- Updated dependencies [7a874ab]
- Updated dependencies [ba2ccb5]
- Updated dependencies [787c42d]
- Updated dependencies [752b86d]
- Updated dependencies [2f3cfec]
- Updated dependencies [c1b8602]
- Updated dependencies [b9b91b7]
- Updated dependencies [df168d1]
- Updated dependencies [bd93245]
- Updated dependencies [9a8743d]
- Updated dependencies [f17184c]
- Updated dependencies [5674df5]
  - @pwtap/plugin-ai-judge@0.2.0
  - @pwtap/mobile-core@1.4.0
