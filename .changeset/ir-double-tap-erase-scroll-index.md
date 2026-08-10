---
'@pwtap/mobile-core': minor
'@pwtap/mobile-inspector': minor
'@pwtap/plugin-maestro': minor
'@pwtap/plugin-appium': minor
---

Four actions the drivers could always do, and the ordinal a list row needs

**`doubleTap`, `eraseText`, `hideKeyboard`, `scrollUntilVisible`.** All four were reachable from the Maestro
session layer already and absent from the action IR, so no recording could contain one and no generated test
could call one — a flow that clears a field and scrolls to a row forty items down had to be finished by hand.
Both adapters implement all four; the two that needed care are worth stating:

- `eraseText` clears the whole field by default and takes `characters` for a partial erase. Maestro's own
  command acts on the focused field, so the adapter taps and erases in one call; Appium's `clearValue` can
  only empty a field, so a partial erase is that many backspaces to the focused element instead of pretending.
- `scrollUntilVisible` is a Maestro primitive and a bounded look-then-scroll loop on Appium, with the timeout
  in `ACTION_DEFAULTS` rather than invented inside the adapter. The platform-specific alternatives were both
  narrower: `UiScrollable().scrollIntoView` only accepts a `UiSelector`, so an accessibility-id locator could
  not use it, and iOS's predicate scroll needs a container element a recording does not have. Running it on a
  device caught the first version dropping `timeoutMs` on Maestro — a four-second budget spent twenty seconds
  looking — which is the silent-substitution §5 forbids; the timeout is forwarded to Maestro's own `timeout`.

**`MobileLocator.index`** — 0-based, selects among the matches. This is the case where the locator engine had
nothing good to offer: in a repeated list row every attribute is non-unique, so the text lost 25 points and
the only thing ranked below it was a raw coordinate. The engine now adds an ordinal candidate at `base − 10`
— under anything genuinely unique, over the coordinate it replaces — and says that reordering the list changes
what it resolves to. Both drivers express it natively (Maestro's `index`, WebdriverIO's match list), so it
stays portable; Maestro's relational selectors (`childOf`, `containsChild`) would not, and are deliberately
left to `native`.

`@pwtap/mobile-core`'s README documented `{ text: 'Log in', index: 1 }` before the field existed. It does now.

Adapters implementing `MobileInspectorDriver` need no change: `DriverCapabilities.gestures` is a partial
record, so an adapter that does not list the new kinds simply reports nothing for them and the UI leaves the
controls enabled until the driver refuses one — the same behaviour as before this release.
