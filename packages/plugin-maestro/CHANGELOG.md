# @pwtap/plugin-maestro

## 0.3.1

### Patch Changes

- Updated dependencies [5e8e969]
  - @pwtap/platform@0.3.0

## 0.3.0

### Minor Changes

- c6df135: Add two whole-test evidence capture features, both best-effort (never fail or mask the real test result):

  - `MOBILE_DEVICE_LOG=1` attaches the device's own OS system log (Android `logcat`, iOS the unified system log) as `device-log`. Off by default.
  - Screen recording is **not** a mobile-specific setting — the `maestro` fixture reads Playwright's own built-in `video` option (`use.video` in `playwright.config.ts`), so one central setting governs recording for chromium and maestro alike, honoring all seven of Playwright's video modes (`off`/`on`/`retain-on-failure`/`on-first-retry`/`on-all-retries`/`retain-on-first-failure`/`retain-on-failure-and-retries`, each checked against `testInfo.retry`). Attaches as `maestro-recording`.

- c12d624: Every replayed step now attaches Maestro's real, unedited data for that exact command as `maestro-step-log` — not a synthesized summary. Imperative commands attach the YAML sent over MCP plus Maestro's raw response text; batch YAML steps attach the exact JSON entry Maestro recorded (command + metadata) from `debug/commands-*.json`. A failing step always attaches its log; on a passing step it's opt-in via the new `MOBILE_STEP_LOGS=1` env key, so passing runs stay quiet by default. Also exports `resolveVerboseStepLogs` alongside `resolveScreenshotMode` for bespoke wiring.
- c6df135: ⚠️ Breaking: removed `MOBILE_SCREENSHOT`. Screenshot capture is no longer a mobile-specific setting — the `maestro` fixture now reads Playwright's own built-in `screenshot` option (`use.screenshot` in `playwright.config.ts`, or a project/describe override), the same one `chromium`/`page` tests already use, so one central setting governs both. All four of Playwright's screenshot modes are honored (`off`/`on`/`only-on-failure`/`on-first-failure`, the last collapsing to `only-on-failure` on the first attempt and `off` on any retry). Anyone relying on `MOBILE_SCREENSHOT` should set `use.screenshot` in `playwright.config.ts` instead — the scaffolded template already sets `screenshot: 'only-on-failure'` there, matching the previous default.

  `MaestroMcpSession`'s constructor also changed shape: the trailing positional `screenshotMode`/`binary`/`verboseLogs` parameters are now a single `MaestroSessionOptions` object (`new MaestroMcpSession(device, hooks, { screenshotMode, binary, verboseLogs })`), for anyone constructing it directly for bespoke wiring.

### Patch Changes

- Updated dependencies [c6df135]
  - @pwtap/platform@0.2.0

## 0.2.0

### Minor Changes

- e052a8e: Run mobile tests in parallel (the device pool) and auto-close framework-booted devices. The `maestro` project is now `fullyParallel`, and each test reserves its device with a cross-process lock keyed `<platform>:<device>` — tests on the same device serialize (wait, not skip), while different devices/platforms run concurrently with `--workers=N` (Maestro ≳ 2.6, or `MOBILE_PARALLEL=1`). A `maestro-teardown` project now runs after the suite and shuts down the emulators/simulators the framework auto-booted this run — headed or headless — so they don't linger; set `MOBILE_KEEP_DEVICES=1` to keep them.

### Patch Changes

- cc51ac0: Fix the Maestro binary resolving to an empty string when the injected `MAESTRO_BIN` env key is left blank. The code used `process.env.MAESTRO_BIN ?? 'maestro'`, but `??` doesn't fall back on `''`, so runs spawned an empty command (`spawn '' EACCES` / "file cannot be empty"). Use `|| 'maestro'` so a blank value falls back to the `maestro` binary on PATH.
- Updated dependencies [d508646]
  - @pwtap/platform@0.1.1
