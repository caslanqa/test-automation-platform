---
---

No version bump: `@pwtap/plugin-heal@1.0.0` was versioned and tagged but never reached npm.

Its `prepack` build failed during the release — a literal `await import('@pwtap/mobile-core')` made an
optional peer's declarations a compile-time requirement, and `changeset publish` had cleaned that
package's `dist` in a parallel prepack. Nine packages shipped; this one did not.

The fix therefore belongs **inside** 1.0.0 rather than in a 1.0.1 that corrects a version nobody could
install. `changeset publish` will pick it up on the next run: the other nine are already on npm and are
skipped, and `@pwtap/plugin-heal@1.0.0` publishes with the corrected build.

Empty on purpose — this file exists so `changeset status` is quiet and so the reason is written down
somewhere other than a commit message.
