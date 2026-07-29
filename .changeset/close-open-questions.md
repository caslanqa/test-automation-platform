---
'@pwtap/mobile-core': minor
'@pwtap/mobile-inspector': patch
---

Settle the deferred decisions, and stop settling the screen after actions that cannot change it.

**`native` locators: hand-authored only, never ranked.** A native selector is specific to one driver on one
platform by definition, so emitting one from the recorder would produce a recording that replays only under the
driver that made it — the opposite of the premise the whole IR rests on. `MobileLocator.native` stays as the
escape hatch for what the IR cannot express, and both adapters pass it through untouched.
`LocatorCandidate.strategy` no longer lists `native`: the engine never produced it, and a type promising a case
that cannot happen forces dead branches on every consumer.

**Frame re-encoding: not needed.** Measured at ~150 KB per capture against a 2 MB budget.

**A read-only action no longer settles the screen.** Every successful action paid a settle — a sleep, a
hierarchy re-read and up to two captures — including `assertVisible`, `assertNotVisible`, `isVisible` and
`screenshot`, none of which can change what is on screen. Since commands run one at a time, that was also delay
in front of whatever the user did next.

**A run announced as finished had not necessarily cleaned up.** The temp file's removal was fired off unawaited
and `runStatus: finished` was emitted immediately, so a client told the run had ended could still see the file —
the opposite of what §11 promises. It is awaited now. This had been showing up as a test that failed only under
load, three times across one session; it was a real ordering bug wearing a flaky test's clothes.

Two options were measured and declined rather than left vague, both recorded in §14 with their numbers:
capturing frames through `adb` instead of the driver (181 → 130 ms, but a second Android-only capture path in
the layer that has already produced two field defects, for ~8 % of click→screen), and driving Maestro's own
daemon the way Studio does (~420 ms per tap, but an interface Maestro neither documents nor exposes a port
flag for, so we would own every break — while Appium is one option away at 194 ms).

**A recorded drag now carries how far the finger travelled.** §9 required it and the UI never did: every drag
collapsed into a direction-only full-screen swipe, so a short flick and a long pull recorded identically and
the generated test scrolled a different amount than the user had. It sends the measured fraction of the swept
axis now — possible only because `SwipeOptions.distance`, dead in both adapters until this round, is honoured.
The start point is still not carried, and §9 says so rather than claiming the item is closed.
