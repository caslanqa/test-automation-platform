---
'@pwtap/create': patch
'@pwtap/mobile-inspector': patch
'@pwtap/platform': patch
'@pwtap/plugin-ai-judge': patch
'@pwtap/plugin-appium': patch
'@pwtap/plugin-maestro': patch
---

Harden mobile-inspector/runtime compatibility and raise the Node baseline.

- `@pwtap/mobile-inspector` now loads platform APIs through a compatibility bridge so outdated
  `@pwtap/platform` installs fail with a clear upgrade error instead of crashing module load on
  missing named exports.
- Tighten plugin runtime dependency ranges to mobile-inspector/platform versions that include the
  inspector integration fixes.
- Raise supported Node version to `>=22.23` across the monorepo's publishable packages.
