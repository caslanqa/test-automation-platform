---
'@pwtap/create': minor
---

The V&V agents learn traceability.

New skill **`tms-traceability`** (gated on `plugin:tms`): the two annotations `@pwtap/plugin-tms` reads,
which of them is machine-managed, and what each command will do about them. The load-bearing rule is
that a `QaseID` is **never** written by hand — it names a real record in an external system, and an
invented one points at somebody else's case or at nothing, which the sync then reports as dangling and
refuses to act on.

- **`test-author`** claims a requirement in the spec it writes (`annotation: { type: 'Requirement' }`),
  and owns the new skill.
- **`story-reviewer`** gives its acceptance criteria a file: `requirements/<id>.md` with the `**AC-n**`
  markers a test cites. Numbering is a contract — a criterion id that moves silently re-points every
  test that cited it — and anything not started belongs at `status: draft`, because a gate that fails on
  future work gets switched off.
- **`suite-reviewer`** flags a hand-written `QaseID`, and asks once about a new spec with no
  `Requirement` annotation — an untraced test is invisible to the coverage gate.
- **`/vv`** gains a traceability row and the reminder that **covered is not verified**: a requirement
  whose only test was skipped or never ran is neither.

`story-reviewer` and `/vv` reference the commands as plain code spans rather than `{{script:…}}`, so a
project without the plugin is not warned about a script it was never meant to have — the same defect
`mobile-vv` had with the two mobile drivers.
