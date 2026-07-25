# @pwtap/plugin-appium

## 0.1.4

### Patch Changes

- 76bd9d8: Harden mobile-inspector/runtime compatibility and raise the Node baseline.

  - `@pwtap/mobile-inspector` now loads platform APIs through a compatibility bridge so outdated
    `@pwtap/platform` installs fail with a clear upgrade error instead of crashing module load on
    missing named exports.
  - Tighten plugin runtime dependency ranges to mobile-inspector/platform versions that include the
    inspector integration fixes.
  - Raise supported Node version to `>=22.23` across the monorepo's publishable packages.

- Updated dependencies [76bd9d8]
  - @pwtap/mobile-inspector@0.1.2
  - @pwtap/platform@0.3.2

## 0.1.2

### Patch Changes

- 8e3f7f7: Fix two issues that made mobile runs unreliable out of the box:

  - `create-pwtap add appium`'s host check now **installs** the missing `uiautomator2`/`xcuitest` Appium drivers (`appium driver install ...`) instead of only warning about them — a missing driver deterministically fails every session on that platform with the same confusing `Could not find a driver for automationName '...'` error, so there's no reason not to fix it automatically.
  - The scaffolded `appium` project now defaults to a 180s `timeout` (was Playwright's default). XCUITest builds WebDriverAgent from scratch the first time it's needed for a given Xcode/simulator combination, which alone can take well over a minute — under a short timeout this showed up as iOS "randomly" never launching. Once WebDriverAgent is built it's cached and later sessions are fast.

## 0.1.1

### Patch Changes

- Updated dependencies [5e8e969]
  - @pwtap/platform@0.3.0
