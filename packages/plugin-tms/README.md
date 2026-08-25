# @pwtap/plugin-tms

Test management sync for a `@pwtap` Playwright suite. Qase is the first provider, selected with
`TMS_PROVIDER`.

```bash
npx @pwtap/create add tms
```

No fixture, no Playwright project, nothing a spec imports. A reporter and a CLI — because the work is
either a reporter hook or a command someone runs, never something that happens inside a test.

## What it does today

**Results, with every artifact.** The official `playwright-qase-reporter` is wrapped rather than
reimplemented: `trace.zip`, `video.webm`, screenshots and Playwright's `error-context.md` are uploaded
with the failure that produced them, `test.step()` becomes Qase steps, `browserName` becomes a run
parameter, a test that only passed on a retry is marked flaky, and results publish in batches while the
run is still open.

**Off until you ask.** `TMS_MODE` is `off` by default. With it off no provider is resolved, no client is
built, and every reporter hook returns immediately — installing this plugin does not change what
`npx playwright test` does.

**Runs that survive sharding.** Four shards are four processes; if each opened its own run you would get
four runs holding a quarter of the suite each, and if each completed the run the first to finish would
close it under the other three. So:

```bash
npx tms run create             # writes QASE_TESTOPS_RUN_ID to qase.env
set -a && . ./qase.env && set +a
npx playwright test --shard=1/4 & npx playwright test --shard=2/4 & wait
npx tms run complete
```

**A doctor that answers before you need it.**

```
$ npm run tms:doctor
provider     qase
mode         testops
environment  staging
run title    main · a1b2c3d · staging
✓ configuration  project DEMO
✓ project        Demo Project reachable at https://api.qase.io/v1
```

## Configure

In `env/environments.json` → `common`: `TMS_PROVIDER`, `TMS_MODE`, `QASE_TESTOPS_PROJECT`. Export
`QASE_TESTOPS_API_TOKEN` from your secret store rather than committing it — an exported variable always
wins over the file.

`TMS_MODE=testops` with no token **throws before a single test runs**, rather than quietly publishing
nothing. A green CI job next to an empty run is the failure nobody catches.

Full guide, including the CI snippet and a table of every failure message: [`docs/TEST_MANAGEMENT.md`](docs/TEST_MANAGEMENT.md).

## Case sync

```bash
npm run tms:sync            # print the plan, change nothing
npm run tms:sync -- --apply # create, link, update, and write the ids back into the specs
```

Your specs are the source of truth. Discovery goes through `playwright test --list`, so **no test is
run** and no browser starts. A test finds its case by its `QaseID` annotation first, and by suite path
plus title only when it has none yet — and a match found that way is written back:

```ts
test('rejects an expired card', { annotation: { type: 'QaseID', description: '42' } }, async ({ page }) => { … });
```

That edit is Qase's own recommendation, not a style choice: name matching breaks on a rename, an id
does not. An annotation you already wrote is merged with, never replaced.

**Nothing is ever deleted.** A case the code no longer contains is reported as an orphan;
`--deprecate-orphans` marks it, looking the status value up in your workspace rather than assuming an
integer. With no `--apply` the command exits `1` when the tool and the code have drifted, so it works
as a CI check.

Two call sites cannot hold an id and are reported instead of guessed at: a parameterised loop, and a
helper that declares tests on your behalf. Those stay matched by title.

## Coming next

A requirements traceability matrix built from `requirements/*.md` with a CI coverage gate
(`tms trace`), and defect creation from confirmed `true-fail` triage.
