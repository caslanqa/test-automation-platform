---
name: tms-traceability
description: 'How a test claims a requirement and how a case id gets into a spec — the two annotations `@pwtap/plugin-tms` reads, which of them is machine-managed, and what `tms sync` / `tms trace` will do about them. Use before adding a Requirement annotation, before running either command, and when a coverage gate fails.'
requires: plugin:tms
---

Two annotations, and the difference between them is the whole skill:

```ts
test('rejects an expired card', {
  annotation: [
    { type: 'Requirement', description: 'PAY-17#AC-1' }, // YOU write this
    { type: 'QaseID', description: '42' },               // the SYNC writes this
  ],
}, async ({ request }) => { … });
```

| Annotation    | Owner              | Meaning                              |
| ------------- | ------------------ | ------------------------------------ |
| `Requirement` | you                | which requirement this test verifies |
| `QaseID`      | `tms sync --apply` | which case in the tool this test IS  |

## Never invent a QaseID

A case id is a real record in an external system. Writing one by hand either points at somebody else's
case or at nothing at all, and the second is worse — the sync reports it as **dangling** and refuses to
recreate it, because recreating would start a second history for the same test.

If a test has no id, that is the correct state until `tms sync --apply` gives it one. Leave it alone.

## Writing a Requirement annotation

The key comes from a file in `{{projectDir}}/requirements/`. Two granularities:

- `PAY-17` — this test verifies the requirement.
- `PAY-17#AC-1` — it verifies that one acceptance criterion. This also counts for the requirement.

Prefer the criterion form when the test really does check one criterion; it is what makes a matrix
useful rather than merely present. One annotation may carry several keys: `description: 'PAY-17, PAY-18'`.

**A key that no file defines is a finding, not a note.** `tms trace` reports it as dangling and the gate
fails. If the requirement does not exist yet, write the file first — see `{{ref:acceptance-criteria}}`
for what belongs in one.

## Before running either command

Both default to a dry run and both are worth reading before `--apply`:

```
{{script:tms:sync}}     # what would be created, linked, updated — and what is orphaned
{{script:tms:trace}}    # the matrix, and what is uncovered
```

`tms sync --apply` **edits spec files** to write the ids back. That is Qase's own recommendation — an id
survives a rename, a title does not — but it means the diff should be read before it is committed.

## Two call sites that cannot hold an id

The sync reports these rather than writing to them, and it is right to:

- **a parameterised loop** — `for (const role of […]) test(\`works for ${role}\`, …)`is one`test()` call
  producing several tests, so one id would name all of them;
- **a helper that declares tests** — `test.as('admin')(…)` puts the `test()` call in `fixtures/`, and an
  id written there would tag the helper and every test that has ever used it.

Those tests stay matched by suite path and title, which **breaks on a rename**. If a test's history
matters, give it its own `test()` call.

## Reading a failed gate

`{{script:tms:gate}}` fails on five things. Each has a different fix:

| Finding     | What to do                                                                      |
| ----------- | ------------------------------------------------------------------------------- |
| `uncovered` | write the test, or move the requirement to `status: draft` if it is not started |
| `failing`   | a linked test went red — this is a product finding, not a traceability one      |
| `not-run`   | the requirement's tests did not execute in that run. Check which project ran    |
| `dangling`  | a `Requirement` key no file defines — fix the typo, or write the file           |
| `problem`   | a requirement file that would not parse; the message names the line             |

`draft`, `review` and `obsolete` requirements are excluded by design. Retiring a requirement is a
legitimate answer to an uncovered one; deleting the gate is not.

## Covered is not verified

A test naming a requirement makes it **covered**. That test running and passing makes it **verified**.
A skipped test proves nothing and never counts. Do not report a requirement as done because it appears
in the matrix — check the verdict column.
