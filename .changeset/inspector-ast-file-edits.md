---
'@pwtap/mobile-inspector': minor
---

Edit test files through the project's TypeScript compiler instead of by string search (ADR-005).

Recording into a file found its insertion point with `lastIndexOf('\n});\n')`, which lands in the wrong place
as soon as the file has a helper, a trailing object literal or a second test — the statement then went
outside the test body and the generated file did not compile. Appending to an existing file dropped every
import the target did not already have unless it lacked `@fixtures` entirely.

Both now parse with the project's own `typescript` (resolved from the project, not bundled — ADR-014): the
statement goes at the end of the last `test(...)` block, and a merge unions imports by module specifier and
wraps the appended body in its own `test.describe` so the generated `test.use()` cannot rewrite the target
file's configuration. Nothing is re-emitted from the AST — the original text is sliced at the positions the
parser reports, so formatting and comments survive. A project without `typescript` degrades audibly instead
of silently mangling the file.
