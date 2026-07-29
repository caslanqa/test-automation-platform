---
'@pwtap/mobile-core': minor
'@pwtap/plugin-maestro': patch
'@pwtap/plugin-appium': patch
'@pwtap/mobile-inspector': patch
---

Audit the two driver adapters: four defects where the driver-neutral contract was neutral in name only.

**The same test behaved differently on each driver.** Every action option is optional, and each adapter
invented its own default for the ones a test omitted — `isVisible` waited 2 s on Maestro and 5 s on Appium,
`longPress` held 1 s on Appium and whatever Maestro chose. A test written once and run on both, which is the
entire promise, could pass on one and fail on the other purely on timing. The defaults now live in the
contract (`ACTION_DEFAULTS` in `@pwtap/mobile-core`) and both adapters resolve from there. `isVisible` stays
short and `waitFor` gets Playwright's own 5 s, because they are asked different questions.

**`SwipeOptions.distance` did nothing at all.** Declared in the IR, exposed by the fixture, and read by
neither adapter — so `swipe('up', { distance: 0.3 })` silently swiped the full screen on both drivers. It is
now honoured: as `percent` on Appium/Android and as start/end percentage points on Maestro, whose
direction-only swipe has no distance of its own. XCUITest swipes by direction only, so Appium/iOS refuses a
requested distance instead of swiping a different amount and calling it done.

**Maestro discarded `longPress`'s `durationMs`.** Its own `longPressOn` takes the same properties as `tapOn`
and no duration (confirmed against Maestro's cheat sheet), so a recorded 3-second press was never one. It now
refuses, the way `scroll` already refused `within`.

**The capability matrix lied on iOS.** `MobileInspectorDriver.capabilities` is one static answer given before
a platform is known, so the Appium driver declared `back: true` and then threw `"back" has no iOS equivalent`
— which left the inspector offering a Back button that always failed and the fixture's support check passing.
A session may now narrow the declaration for the platform it connected to (`DriverSession.capabilities`,
optional, so no contract bump), and the fixture and the UI both prefer it.

Verified on real devices: Appium/iOS reports `back: false` where the driver still declares `true`, a distance
swipe is honoured on Maestro and Appium/Android and refused on Appium/iOS, and a `longPress` with a duration
is refused on Maestro rather than quietly held for the wrong time.
