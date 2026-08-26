# Test management sync

Your suite runs; your test management tool learns what happened. Qase is the provider today, selected
with `TMS_PROVIDER`.

**Nothing happens until you ask.** `TMS_MODE` is `off` by default, and with it off this plugin makes no
network call at all — the reporter constructs no client, resolves no provider, and returns from every
hook immediately. Installing it does not change what `npx playwright test` does.

## Configure

Everything lives in `env/environments.json`, in the `common` block:

| Key                      | Default                  | What it does                                          |
| ------------------------ | ------------------------ | ----------------------------------------------------- |
| `TMS_PROVIDER`           | `qase`                   | Which tool. Anything else is refused by name.         |
| `TMS_MODE`               | `off`                    | `testops` publishes. Any other value is `off`.        |
| `QASE_TESTOPS_PROJECT`   | —                        | The project **code** (`DEMO`), not its title.         |
| `QASE_TESTOPS_API_TOKEN` | —                        | From <https://app.qase.io/user/api/token>.            |
| `QASE_TESTOPS_RUN_ID`    | —                        | Set by CI so shards share a run. Leave empty locally. |
| `QASE_API_BASE_URL`      | `https://api.qase.io/v1` | Self-hosted, or a test double.                        |

`env/environments.json` is gitignored (`environments.example.json` is the tracked one), but **do not put
the token there anyway**. An exported variable always wins over the file, so the right place is your
secret store:

```yaml
# .github/workflows/e2e.yml
env:
  TMS_MODE: testops
  QASE_TESTOPS_API_TOKEN: ${{ secrets.QASE_API_TOKEN }}
```

## Check the wiring before you need it

```bash
npm run tms:doctor
```

```
provider     qase
mode         testops
environment  staging
run title    main · a1b2c3d · staging
✓ configuration  project DEMO
✓ project        Demo Project reachable at https://api.qase.io/v1
```

Every check prints, including the ones after a failure — a run with neither a token nor a project code
should teach you both facts at once. Exit code is `1` if any check failed.

## Run

```bash
TMS_MODE=testops npx playwright test
```

A run opens titled `<branch> · <sha> · <environment>` and results publish in batches of 100 **while the
suite is still going**, so a long suite is readable in Qase before it finishes. On CI the branch and sha
come from the CI variables rather than `git rev-parse`, because a detached HEAD reports its branch as
`HEAD` and a run list full of `HEAD` is a run list nobody can read.

### What gets uploaded with a failure

Everything Playwright produced for it: `trace.zip`, `video.webm`, screenshots, and — for Playwright
1.51+ — `error-context.md`, whose text also lands in Qase's copyable error-context field. That is
governed by your own `use: { trace, video, screenshot }` settings; this plugin uploads whatever the
runner attached, it does not decide what to capture.

`test.step()` becomes Qase steps. `browserName` becomes a run parameter, so the same case passing on
chromium and failing on webkit reads as two facts rather than one confusing one. A test that only passed
on a retry is marked flaky.

## Sharding needs two commands

Four shards are four processes. If each one opened its own run you would get four runs holding a quarter
of the suite each; if each one _completed_ the run, the first to finish would close it under the other
three. So CI opens the run once, tells every shard its id, and closes it at the end:

```bash
npx tms run create --title "$GITHUB_REF_NAME"   # writes QASE_TESTOPS_RUN_ID=… to qase.env
set -a && . ./qase.env && set +a                # every shard exports the same id

npx playwright test --shard=1/4 &
npx playwright test --shard=2/4 &
npx playwright test --shard=3/4 &
npx playwright test --shard=4/4 &
wait

npx tms run complete
```

`qase.env` is the same filename and key `qasectl` uses, so an existing CI snippet keeps working. In
GitHub Actions the same thing is `cat qase.env >> "$GITHUB_ENV"`.

When `QASE_TESTOPS_RUN_ID` is set the reporter joins that run and **never completes it**. When it is
unset the reporter owns the run and completes it itself, which is what you want locally.

### `tms run create` options

| Flag                               | Effect                                         |
| ---------------------------------- | ---------------------------------------------- |
| `--title <t>`                      | Overrides the git-derived title.               |
| `--description <d>`                | Free text on the run.                          |
| `--environment <slug>`             | Qase environment slug. Defaults to `TEST_ENV`. |
| `--milestone <id>` / `--plan <id>` | Bind the run to a milestone or test plan.      |
| `--tags a,b`                       | Run tags.                                      |
| `--output <file>`                  | Where to write the id. Default `qase.env`.     |

`tms run complete` takes the id from `--id`, else `QASE_TESTOPS_RUN_ID`, else the file — and refuses
rather than guessing when it has none.

## Case sync

```bash
npm run tms:sync            # print the plan, change nothing
npm run tms:sync -- --apply # create, link, update, and write ids back into the specs
```

Your specs are the source of truth; the tool is the mirror. Discovery goes through
`playwright test --list` — **no test is run**, no browser starts.

### How a test finds its case

Two passes, in this order:

1. **By id.** A `QaseID` annotation is exact and permanent. Rename the test, move it to another file,
   restructure the describes — it still points at the same case, and the history stays whole.
2. **By suite path and title**, only for tests with no id yet. A match here is _adopted_: the id is
   written into the spec so the next sync uses pass 1 and the link stops depending on the title.

That write-back is not a stylistic choice. Qase's own documentation is explicit that name matching
"sees a 'new' test and the old one's history stops" on a rename, and that the id in code is the link
that survives. So `--apply` edits your spec files:

```ts
// before
test('rejects an expired card', async ({ page }) => { … });

// after
test('rejects an expired card', { annotation: { type: 'QaseID', description: '42' } }, async ({ page }) => { … });
```

An existing annotation is merged with, never replaced — a `Requirement` annotation you wrote stays and
becomes the first entry of an array. Commit the result; it is what makes the next sync a no-op.

### The suite path

Directory segments, then the file stem, then each `describe`. `tests/checkout/cart.spec.ts` with
`describe('totals')` puts the case under `checkout › cart › totals`. Suites are created as needed and
reused; nothing is created twice.

### What the plan tells you

| Section                 | Meaning                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `create`                | no id, no title match — a new case, and the id is written back                                                       |
| `adopt`                 | an existing case with this suite path and title — linked, and the id is written back                                 |
| `update`                | linked, but the title, suite or tags drifted; the tool is corrected to match the code                                |
| `orphans`               | automated cases with no test in the code — **never deleted**, only listed                                            |
| `dangling`              | the annotation names a case that is not in this project — never recreated; remove the annotation or restore the case |
| `matched by title only` | the id cannot be written at that call site, so the link stays fragile                                                |

`--deprecate-orphans` marks orphans deprecated instead of only listing them. It looks the status value
up in your workspace's own system fields rather than assuming an integer, and refuses if there is no
"deprecated" option. Nothing here ever deletes a case: the run history is the reason it exists.

### Where an id cannot go

Two call sites cannot hold one, and the sync says so rather than writing the wrong thing:

- **A parameterised loop.** `for (const role of […]) test(\`works for ${role}\`, …)`is one`test(` call
  producing several tests. An annotation there would give all of them the same case id.
- **A helper that declares tests.** `test.as('admin')(…)` puts the `test(` call inside `fixtures/ui.ts`,
  outside the tests directory. Writing there would tag the helper, and through it every test that uses it.

Those tests still get cases and still report results. They stay matched by suite path and title, which
means **renaming one starts a new case and ends the old one's history**. Give a test its own `test()`
call when its history matters.

### As a CI check

`tms sync` with no `--apply` exits `1` when there is anything to create, link or update, and `0` when
the tool already matches the code — so a job can fail on drift:

```yaml
- run: npm run tms:sync # fails if a new test has no case in Qase
```

`--project <name>` limits discovery to one Playwright project; `--limit <n>` sets how many lines each
section of the report prints (it always says how many it dropped).

## Requirements and traceability

```bash
npm run tms:trace   # write the matrix to tms/
npm run tms:gate    # the same thing, and exit 1 on a gap
```

Both are **entirely local**: no token, no network, no test run. That is deliberate — the matrix is the
artifact an auditor is handed and the check a pull request runs, and neither should depend on a
third-party service being reachable.

### Why requirements live in the repo

Qase has **no requirements API**. Its own traceability report is built from _external issues_ — a case
linked to a Jira, GitHub, GitLab, Linear or Azure DevOps ticket. With no tracker wired up there is
nothing on that side to sync to, so requirements live next to the tests:

```markdown
<!-- requirements/pay-17.md -->

---

id: PAY-17
title: An expired card is rejected at checkout
status: valid # valid | draft | review | implemented | obsolete
type: user-story # epic | feature | user-story
parent: PAY-1
---

## Acceptance criteria

1. **AC-1** — Paying with an expired card returns HTTP 422 and the code `card_expired`.
2. **AC-2** — The user is shown "Your card has expired".
```

`id` and `title` are required; everything else has a default. A criterion is any line carrying a bold
`**AC-n**` marker — numbered list, bullet or bare line, whichever reads better.

A file that will not parse is **reported and fails the gate**, never skipped: silently dropping it
would shrink the denominator and make coverage look better than it is.

### How a test claims one

```ts
test('rejects an expired card', {
  annotation: { type: 'Requirement', description: 'PAY-17#AC-1' },
}, async ({ request }) => { … });
```

`PAY-17` covers the requirement as a whole. `PAY-17#AC-1` covers it **and** that one criterion. Both
count toward requirement coverage — a team that has not adopted criterion-level linking is not told its
whole matrix is empty.

One annotation can carry several keys: `description: 'PAY-17, PAY-18'`.

### Covered is not verified

Two questions the matrix keeps apart, because conflating them is how a matrix starts lying:

| Verdict        | Meaning                                                                         |
| -------------- | ------------------------------------------------------------------------------- |
| ✅ `verified`  | a test names it, that test ran, and it passed                                   |
| ❌ `failing`   | a test names it and went red — **covered, not verified**                        |
| ⚪ `not-run`   | a test names it, and that test did not execute in the last run (or was skipped) |
| 🚫 `uncovered` | no test names it at all                                                         |
| ➖ `excluded`  | its status is `draft`, `review` or `obsolete` — not held to account yet         |

One red test among five green ones makes the requirement `failing`. A **skipped** test never counts as
evidence: "there is a test and it did not fail" is not the same claim as "a test proved this".

Outcomes come from `test-results/results.json` — the JSON report the scaffold's config already writes.
Point somewhere else with `--results <file>`. With no results file the command says so and nothing is
called verified.

### The report

`tms/rtm.md` and `tms/rtm.json` by default; add `--format md,json,csv` for the spreadsheet an auditor
will ask for. Every report is stamped with the branch, the commit sha and a timestamp, so an exported
matrix is attributable to a state of the repository. `--out <dir>` moves them.

The JSON is a stable schema (`pwtap.tms.rtm/1`) with counts, per-requirement verdicts, per-criterion
verdicts and the linked tests including their case ids — meant to be read by other tools.

### The gate

```yaml
- run: npx playwright test # produces test-results/results.json
- run: npm run tms:gate # fails on a gap
```

Exit `1` on any of: an uncovered requirement, a failing one, one whose tests did not run, a test naming
a requirement no file defines, or a requirement file that would not parse. `--strict` also requires
every declared acceptance criterion to be covered.

`draft`, `review` and `obsolete` requirements are excluded. A gate that fails on work not started yet
gets switched off, and a switched-off gate protects nothing — so the example requirement this plugin
installs ships as `draft`.

### The Qase side

`tms sync` also writes the requirement keys into a **text custom field named `Requirement`** on each
case, which makes them visible, filterable and QQL-searchable in Qase. The field is **never created for
you** — that is workspace schema, and a sync command reshaping your Qase project is more than it was
asked to do. Create it in Settings → Custom fields (entity "Test case", type "Text"), or ignore it: the
sync says so once and carries on, and the local matrix is unaffected.

When you later connect a real tracker, the same key moves to `POST /case/{code}/{id}/external-issues`
and Qase's own requirements report fills in. That is the upgrade path, not a rewrite.

## When something goes wrong

| What you see                                                                                      | What it means                                                                                                                         |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `TMS_MODE=testops but QASE_TESTOPS_API_TOKEN is not set`                                          | Construction refuses rather than degrading to a silent no-op. A green CI job next to an empty Qase run is the failure nobody catches. |
| `… → Unauthorized — check QASE_TESTOPS_API_TOKEN and that the token owner can reach this project` | The token is wrong, expired, or belongs to someone without access to that project.                                                    |
| `unknown TMS_PROVIDER "testrail"`                                                                 | A typo, or a provider that does not exist yet. Known providers are listed in the message.                                             |
| A run is missing a third of its results                                                           | A shard completed the run. Check that `QASE_TESTOPS_RUN_ID` is exported in **every** shard.                                           |

| `N id(s) could not be placed automatically` | The cases exist; only the annotation is unwritten. Paste the printed snippet — the next sync adopts the case by title rather than creating a duplicate. |
| `Playwright could not load the suite` | A spec fails to import. The sync stops there on purpose: a suite that lists nothing looks exactly like a suite whose tests were all deleted. |
| `refusing to guess which id belongs to which test` | A bulk create came back with the wrong number of ids. Nothing was written back; re-run the sync. |
| `unknown frontmatter key "statuss"` | A typo in a requirement file. Unknown keys are refused by name rather than ignored, so a misspelled `status` cannot silently become the default. |
| `duplicate id PAY-17 — already defined in …` | Two requirement files answering to one key make every link ambiguous. The first file wins and the second is reported. |
| `no run results at test-results/results.json` | The suite has not been run since the report was deleted. Coverage still works; nothing is called verified. |
Rate limits are Qase's: 1000 requests/minute per user, 3000 per IP. The client honours `Retry-After` on
429 and backs off on 5xx, four attempts, then fails loudly — a sync that reports success it did not
achieve is worse than one that exits non-zero.
