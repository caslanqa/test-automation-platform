---
'@pwtap/mobile-inspector': major
'@pwtap/plugin-maestro': major
'@pwtap/plugin-appium': minor
'@pwtap/create': minor
---

Make the Mobile Inspector produce tests that actually run.

Recording, saving and replaying a mobile flow never worked end to end: the generated test imported a
fixture nobody wired into the `@fixtures` barrel, omitted the `platform` and `appId` needed to connect,
pinned an `adb` serial that dies on reboot, ran under the browser project, and asserted visibility through
an action that could only ever throw. This closes that loop, verified on real Android emulators and iOS
simulators with both drivers. See `docs/mobile-inspector/architecture.md` for the full design and the
decision record.

### Breaking — `@pwtap/mobile-inspector`

- The driver/device selection option is now **`mobileTarget`** and the facade fixture is **`mobileApp`**
  (previously `mobile` and `app`). Both old names collided with fixtures the mobile plugins already own —
  `@pwtap/plugin-maestro` owns the `mobile` option and `@pwtap/plugin-appium` owns the `app` fixture — and
  in Playwright an option _is_ a fixture, so the collision was a merge conflict rather than an override.
  `mobileTarget` also gains `appId` and `appSource`, which are now forwarded to the driver instead of
  being dropped.

  ```diff
  - test.use({ mobile: { driver: 'appium', device: 'emulator-5554' } });
  - test('flow', async ({ app }) => { await app.tap({ accessibilityId: 'login' }); });
  + test.use({ mobileTarget: { driver: 'appium', platform: 'android', device: 'Pixel_7_API_34', appId: 'com.example.app' } });
  + test('flow', async ({ mobileApp }) => { await mobileApp.tap({ accessibilityId: 'login' }); });
  ```

- `MobileApp.isVisible()` now resolves `false` when the element is absent instead of throwing. It is
  backed by a new `isVisible` action in the driver-neutral IR; previously it routed through
  `assertVisible`, which throws on absence, so every generated "assert not visible" failed. Generated code
  now emits `await expect.poll(() => mobileApp.isVisible(...)).toBe(...)`.
- `MobileInspectorDriver` requires a `testBinding` (`{ extension, project, gateEnv }`). A driver now
  declares where its tests live and how they run, so adding a driver needs no changes inside the inspector.
- The trust boundary validates an action's fields, not just its `kind`. Payloads like a `fill` with no
  `value` or a `swipe` with an invented `direction` are rejected instead of reaching an adapter.

### Breaking — `@pwtap/plugin-maestro`

- The `maestro` Playwright project now matches **`*.maestro.ts`** instead of `*.mobile.ts`, so a file's
  extension names the driver that runs it for hand-written and recorded tests alike. Existing tests need a
  rename; nothing inside them changes.

  ```bash
  git ls-files 'tests/**/*.mobile.ts' | while read -r f; do
    git mv "$f" "${f%.mobile.ts}.maestro.ts"
  done
  npx create-pwtap add maestro   # re-injects the narrowed project block
  ```

### `@pwtap/plugin-appium`

- Fixed an iOS text locator that could never resolve: node text is read from `label` **or** `value`, but
  the selector only matched `label`, so a locator recorded from a `value`-only element failed with
  "element wasn't found" the first time it replayed.
- Selector values are now escaped, so UI text containing `"` or `\` no longer breaks the predicate.
- Implements the new `isVisible` action without throwing on absence.

### `@pwtap/create`

- `PluginManifest.fixture` accepts an array, letting a plugin contribute more than one fixture. Both mobile
  plugins now also contribute the shared `mobileApp` fixture, injected once and — importantly — left in
  place when only one of them is uninstalled.
- Fixed `hasRegion`, which matched markers as substrings. Because `// pwtap:x:end` contains `// pwtap:x`, a
  file that had lost only its start marker looked intact and then crashed with an unhandled `MarkerError`
  instead of reporting the problem. This affected all four injectors.
