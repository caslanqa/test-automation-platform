---
'@pwtap/mobile-core': minor
'@pwtap/plugin-maestro': patch
'@pwtap/plugin-appium': patch
'@pwtap/mobile-inspector': minor
---

Replace the platform compatibility shim with a declared core↔adapter contract, and validate `appSource`.

`platformCompat.ts` imported `@pwtap/platform` as a namespace and probed each function at load time, so an
outdated install failed with an upgrade message instead of a module-resolution crash. That treated a
versioning problem as a runtime problem for the wrong pair of packages: `@pwtap/platform` is a direct
dependency with a caret range, so npm already resolves a version that has the exports. The shim is deleted.

The pair that genuinely can disagree is core and adapter, because an adapter is resolved from the client
project's own `node_modules`. `@pwtap/mobile-core` now exports `MOBILE_CORE_CONTRACT` and
`MIN_ADAPTER_CONTRACT`, each adapter declares the contract it was built against as a literal
(`export const contract: AdapterContract = 1`), and discovery skips an adapter it cannot accept while
reporting which package to upgrade — the inspector logs it, and `DriverNotFoundError` carries it so "no
driver found" is never the whole story when the adapter is installed but unloadable. One bad adapter does
not disable the others. The `AdapterContract` type is the exact current value, so bumping the contract
breaks each adapter's build until someone confirms it still satisfies the new one.

**`appSource` (ADR-010):** the artifact path comes from a browser field and ends at `adb install` /
`simctl install` / Appium's `app` capability, so it is now validated before an adapter sees it — an existing
local `.apk`/`.ipa`/`.zip` file or `.app` bundle directory, or an `https:` URL. Other schemes are refused,
including `http:`. The adapter receives an absolute path so it never has to guess the base directory, while
the generated test keeps the path as typed: an absolute one would only work on the machine that recorded it.
