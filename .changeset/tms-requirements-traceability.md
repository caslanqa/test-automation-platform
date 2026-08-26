---
'@pwtap/plugin-tms': minor
---

`tms trace` — a requirements traceability matrix built from the repository, and a gate that fails on a
gap.

Qase has **no requirements API**: its own traceability report is fed by external issues, so with no
tracker wired up there is nothing on that side to sync to. Requirements therefore live next to the
tests in `requirements/*.md`, and the matrix is produced here. Everything about the command is local —
no token, no network, no test run — because the artifact an auditor is handed and the check a pull
request runs should not depend on a third-party service being reachable.

- **Covered and verified are kept apart.** A test naming a requirement makes it covered; that test
  running and passing makes it verified. One red test among five green ones is `failing`, and a
  **skipped test never counts as evidence** — "there is a test and it did not fail" is not the claim
  "a test proved this". A `--list` report carries `status: "skipped"` on every test, and reading that
  as an outcome turned never-executed into green across a whole matrix; only `results[]` is read now.
- **Two granularities.** `PAY-17` covers the requirement; `PAY-17#AC-1` covers it and that one
  acceptance criterion. Both count toward requirement coverage, so a team that has not adopted
  criterion-level linking is not told its matrix is empty. `--strict` gates on criteria too.
- **The gate fails on what it should.** Uncovered, failing, covered-but-never-ran (only when a results
  report was actually read), a test naming a requirement no file defines, and a requirement file that
  would not parse — silently skipping a malformed file would shrink the denominator and flatter the
  repository. `draft`, `review` and `obsolete` are excluded: a gate that fails on work not started yet
  gets switched off.
- **Reports are attributable.** Markdown and JSON by default, CSV on request, each stamped with the
  branch, the commit sha and a timestamp. The JSON is a versioned schema (`pwtap.tms.rtm/1`) carrying
  per-requirement and per-criterion verdicts with the linked tests and their case ids.
- **The Qase side, where it exists.** `tms sync` writes the requirement keys into a `Requirement` text
  custom field on each case, making them filterable and QQL-searchable. The field is never created for
  you — that is workspace schema — so the sync reports its absence once and carries on. When a tracker
  is later connected, the same key moves to `external-issues` and Qase's own report fills in.

Run outcomes come from `test-results/results.json`, the report the scaffold's own config already
writes, read with the same parser as the test inventory rather than by coupling to another plugin's
private run records.
