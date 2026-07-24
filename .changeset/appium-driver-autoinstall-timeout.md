---
'@pwtap/plugin-appium': patch
---

Fix two issues that made mobile runs unreliable out of the box:

- `create-pwtap add appium`'s host check now **installs** the missing `uiautomator2`/`xcuitest` Appium drivers (`appium driver install ...`) instead of only warning about them — a missing driver deterministically fails every session on that platform with the same confusing `Could not find a driver for automationName '...'` error, so there's no reason not to fix it automatically.
- The scaffolded `appium` project now defaults to a 180s `timeout` (was Playwright's default). XCUITest builds WebDriverAgent from scratch the first time it's needed for a given Xcode/simulator combination, which alone can take well over a minute — under a short timeout this showed up as iOS "randomly" never launching. Once WebDriverAgent is built it's cached and later sessions are fast.
