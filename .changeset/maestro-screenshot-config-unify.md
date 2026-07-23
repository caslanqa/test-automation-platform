---
'@pwtap/plugin-maestro': minor
---

⚠️ Breaking: removed `MOBILE_SCREENSHOT`. Screenshot capture is no longer a mobile-specific setting — the `maestro` fixture now reads Playwright's own built-in `screenshot` option (`use.screenshot` in `playwright.config.ts`, or a project/describe override), the same one `chromium`/`page` tests already use, so one central setting governs both. All four of Playwright's screenshot modes are honored (`off`/`on`/`only-on-failure`/`on-first-failure`, the last collapsing to `only-on-failure` on the first attempt and `off` on any retry). Anyone relying on `MOBILE_SCREENSHOT` should set `use.screenshot` in `playwright.config.ts` instead — the scaffolded template already sets `screenshot: 'only-on-failure'` there, matching the previous default.

`MaestroMcpSession`'s constructor also changed shape: the trailing positional `screenshotMode`/`binary`/`verboseLogs` parameters are now a single `MaestroSessionOptions` object (`new MaestroMcpSession(device, hooks, { screenshotMode, binary, verboseLogs })`), for anyone constructing it directly for bespoke wiring.
