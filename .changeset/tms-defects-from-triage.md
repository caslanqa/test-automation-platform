---
'@pwtap/plugin-tms': minor
---

`tms defects` — open a defect for a real failure, and for nothing else.

`@pwtap/plugin-heal` decides whether a red test is a genuine failure; this files the ones that are.
**Only `true-fail`.** `flaky`, `locator-drift`, `env-infra` and `unknown` are each skipped with the
reason printed, because a flaky test opening a defect fills the tracker with noise — and a tracker
nobody reads hides the real defect too. A low-confidence `true-fail` is still filed: heal's bands are
heal's contract, and re-thresholding here would be a second, invisible policy.

- **No duplicates.** The title is derived from the test (`<describes › title> — <file>`), so the same
  failure produces the identical title every run and an _open_ defect with it means the work is already
  tracked. A resolved one does not count — the same test failing after a fix is a regression.
- **Nothing is inferred.** The body carries the run id, the commit, the classification with its
  confidence and band, and heal's own reasons. Severity comes from a `GET /system-fields` lookup by
  slug, because Qase requires it as an integer and never documents which one.
- **The quarantine list is mirrored** onto the cases as `is_flaky`, one-way: the committed file is
  policy, the tool is the mirror. A quarantined test with no linked case is reported, not skipped.

**This never imports `@pwtap/plugin-heal`.** It reads that plugin's two documented artifacts —
`.heal/triage.json` and `heal/quarantine.json` — by path. A file contract buys everything an optional
peer dependency would and costs nothing: no build coupling (heal's own `optionalPeers.test.ts` exists
because a literal dynamic specifier once broke a release), no version skew, and a project without heal
simply has no such file, which the command says plainly.
