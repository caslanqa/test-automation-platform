---
'@pwtap/mobile-core': minor
---

Capture the element tree when a mobile test fails, so the screen survives the session that showed it

Playwright writes an `error-context` attachment carrying an ARIA snapshot when a web test fails, and
that file is what lets anything reason about a moved element after the run is over. Mobile had no
equivalent: the driver session is the only thing that could answer, and it is closed in the fixture's
teardown moments later.

The `mobileApp` fixture now calls `inspectHierarchy()` once, **on failure only**, and attaches the
result as `mobile-hierarchy` — identity keys assigned, so a reader can re-resolve a node rather than
count positions (ADR-007).

Useful on its own: a failing mobile test's report now carries the screen it failed on. It is also what
makes `@pwtap/plugin-heal`'s mobile repair possible without a device probe, which in turn is what makes
it testable in CI at all.

**A green run pays one comparison.** This is not an auto-fixture — only a test that asked for
`mobileApp` instantiates it, and by teardown the driver is already connected — so the objection that
rules out a capture fixture elsewhere (that depending on a device would boot one for every test in the
project) does not apply.

It never changes a verdict. A driver with no hierarchy support is not asked; a device that has already
gone, or an attachment that fails to write, is swallowed. A diagnostic that can fail a passing run, or
that replaces the reason a human needs with one they do not, is worse than no diagnostic.
