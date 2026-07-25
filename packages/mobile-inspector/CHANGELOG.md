# @pwtap/mobile-inspector

## 1.0.0

### Major Changes

- 5f96d85: mobile inspector issue fix

### Patch Changes

- Updated dependencies [5f96d85]
  - @pwtap/platform@1.0.0

## 0.1.2

### Patch Changes

- 76bd9d8: Harden mobile-inspector/runtime compatibility and raise the Node baseline.

  - `@pwtap/mobile-inspector` now loads platform APIs through a compatibility bridge so outdated
    `@pwtap/platform` installs fail with a clear upgrade error instead of crashing module load on
    missing named exports.
  - Tighten plugin runtime dependency ranges to mobile-inspector/platform versions that include the
    inspector integration fixes.
  - Raise supported Node version to `>=22.23` across the monorepo's publishable packages.

- Updated dependencies [76bd9d8]
  - @pwtap/platform@0.3.2
