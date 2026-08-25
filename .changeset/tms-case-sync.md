---
'@pwtap/plugin-tms': minor
---

`tms sync` — mirror the specs in your repo as cases in the tool.

Discovery goes through `playwright test --list --reporter=json`, so **no test is run and no browser
starts**. That output is also the only source that gets `describe` nesting, project membership, declared
annotations and parameterised loops right; a regex over the spec files gets each of them wrong, and every
one of those is a case created in the wrong place or not at all.

- **Two-pass matching.** A `QaseID` annotation is exact and permanent and outranks everything. A test
  without one is matched by suite path and title, and that match is then **written back into the spec**
  so the next sync uses the id. Qase's own documentation is why: name matching "sees a 'new' test and
  the old one's history stops" on a rename.
- **The write-back merges, never replaces.** A `Requirement` annotation you wrote stays and becomes the
  first entry of an array. The editor works from the exact line and column the runner reported, and
  **refuses** anything it cannot place with certainty — handing back the file, the line and the snippet
  to paste rather than guessing at somebody's source file.
- **Two call sites cannot hold an id**, and are reported instead of written to: a parameterised loop
  (one `test()` call, several tests) and a helper that declares tests on the caller's behalf (the
  `test()` call lands in `fixtures/`, outside the tests directory). Writing there would name something
  other than the one test.
- **Nothing is ever deleted.** A case the code no longer contains is an orphan: listed, and marked
  deprecated only under `--deprecate-orphans` — which looks the status value up in the workspace's own
  system fields instead of assuming an integer the API never documents.
- **`--dry-run` is the default** and is the same computation `--apply` runs. With no `--apply` the
  command exits `1` when the tool and the code have drifted, so it doubles as a CI check.

Suites come from the directory path, the file stem and each `describe`, created once and reused.
