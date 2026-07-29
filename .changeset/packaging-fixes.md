---
'@pwtap/mobile-inspector': patch
'@pwtap/mobile-core': patch
'@pwtap/create': patch
---

Fix three defects found by packaging the product and installing it into a clean project.

**Stale build output shipped.** `tsc -b` emits but never prunes, so a moved or deleted source leaves its
`.js`/`.d.ts`/`.map` in `dist` forever. `@pwtap/mobile-inspector` was publishing eleven orphans, including
the three `dist/electron/*` modules ADR-001 removed — dead code importing a package that is not a
dependency — and `@pwtap/mobile-core` shipped the deleted `platformCompat`. Every publishable package now
cleans its output before building (`npm run clean`), and `npm run nfr` fails on any `dist` file with no
matching source.

**Ctrl-C during launch crashed the CLI.** Launching the browser takes a second or two. A signal in that
window left `newPage()`/`goto()` to reject unhandled: the CLI died with a stack trace and exit 1 before
`service.close()` could release the device lock or delete its temp files — precisely the teardown ADR-011
requires — and a signal arriving even earlier killed the process outright, since the handlers were not yet
installed. The handlers now go in before the service starts, the window launcher hands back a closable
handle the moment the browser exists (so a signal mid-launch cannot orphan a Chromium), and a navigation
failure is reported rather than thrown.

**`remove` left a project that would not compile.** Removing a plugin unwires its fixture, Playwright
project, env keys and package, but deliberately leaves the example tests it installed — a user may have
built their suite on them. Silence was the wrong middle ground: `tsc` and `playwright test` both failed on
imports of a package that was gone, with nothing explaining it. The files still stay; `remove` now names
them and says why.

Verified by installing every package from a local tarball into a freshly scaffolded project — no workspace
links, no registry: both mobile plugins wire in with the shared `mobileApp` fixture injected exactly once,
generated `*.maestro.ts`/`*.appium.ts` tests type-check and are collected by their own gated project and no
other, and `mobile-inspect` serves the UI, refuses an untokenised request and exits 0 on a signal.
