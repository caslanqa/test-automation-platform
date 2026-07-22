---
'@pwtap/plugin-maestro': minor
---

Run mobile tests in parallel (the device pool) and auto-close framework-booted devices. The `maestro` project is now `fullyParallel`, and each test reserves its device with a cross-process lock keyed `<platform>:<device>` — tests on the same device serialize (wait, not skip), while different devices/platforms run concurrently with `--workers=N` (Maestro ≳ 2.6, or `MOBILE_PARALLEL=1`). A `maestro-teardown` project now runs after the suite and shuts down the emulators/simulators the framework auto-booted this run — headed or headless — so they don't linger; set `MOBILE_KEEP_DEVICES=1` to keep them.
