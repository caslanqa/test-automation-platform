---
'@pwtap/plugin-appium': patch
---

A gesture on a locator that matches nothing now fails instead of reporting success

Found on an iOS simulator: `doubleTap` against `{ accessibilityId: 'zzz-no-such-element-zzz' }` came back
`ok: true` in 545 ms. WebdriverIO's `$()` is lazy, so a locator that matches nothing still yields an element —
its `elementId` is simply `undefined`. The element _methods_ notice (`click()` and `setValue()` fail with
"element wasn't found"), but the `mobile:` gestures do not call a method: they read the raw id and hand it to
`execute()`, and a driver given `elementId: undefined` answered success.

The check belongs in the one function every one of those gestures already routes through — `doubleTap`,
`longPress`, `pinch`, `scroll` with `within`, and `drag`'s endpoints — so all of them now fail with
`no element matched "<selector>"`. `longPress`, `pinch`, `scroll`-within and `drag` had the same hole before
this release; only `doubleTap` is new.
