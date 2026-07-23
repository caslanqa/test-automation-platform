---
'@pwtap/plugin-maestro': minor
---

Add two whole-test evidence capture features, both best-effort (never fail or mask the real test result):

- `MOBILE_DEVICE_LOG=1` attaches the device's own OS system log (Android `logcat`, iOS the unified system log) as `device-log`. Off by default.
- Screen recording is **not** a mobile-specific setting — the `maestro` fixture reads Playwright's own built-in `video` option (`use.video` in `playwright.config.ts`), so one central setting governs recording for chromium and maestro alike, honoring all seven of Playwright's video modes (`off`/`on`/`retain-on-failure`/`on-first-retry`/`on-all-retries`/`retain-on-first-failure`/`retain-on-failure-and-retries`, each checked against `testInfo.retry`). Attaches as `maestro-recording`.
