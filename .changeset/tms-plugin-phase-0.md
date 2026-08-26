---
'@pwtap/plugin-tms': minor
'@pwtap/create': patch
---

New package: `@pwtap/plugin-tms` — test management sync, with Qase as the first provider.

Phase 0 covers result sync and the run lifecycle. A reporter and a CLI, no fixture and no Playwright
project: the work is either a reporter hook or a command someone runs, never something inside a test.

- **Results, with every artifact.** `playwright-qase-reporter` is wrapped rather than reimplemented, so
  trace, video, screenshots and `error-context.md` go up with the failure that produced them, steps and
  parameters come across, and results publish in batches while the run is still open.
- **Off by default.** `TMS_MODE` is `off` unless set to `testops`. Installing the plugin does not make a
  bare `npx playwright test` reach the network — no provider resolved, no client constructed.
- **Sharding.** `tms run create` / `tms run complete` open one run for every shard to write into. The
  reporter joins an externally-created run and never completes it, so shard 1 cannot close the run on
  shards 2..N.
- **`tms doctor`** prints provider, mode, the run title it would use, and whether the project is
  actually reachable with that token — every check, not just the first failure.
- **Refuses half-configured.** `TMS_MODE=testops` with no token throws before a single test runs. A
  green CI job next to an empty run is the failure nobody catches.

`@pwtap/create` gains the `tms` registry entry (`--tms`).
