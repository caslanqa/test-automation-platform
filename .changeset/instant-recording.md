---
'@pwtap/mobile-inspector': minor
---

Show the recorded action immediately instead of waiting for the device: click → code drops from ~1.4 s to
~3 ms.

Reported from a live installation as 2–3 s of lag on every interaction. Measured on an Android emulator, the
whole cost was the driver's own tap — 1258 ms for Maestro, 75 ms for Appium — and the recorder was waiting
for it before showing anything, because the action was recorded only once the driver confirmed.

Hit-testing is local, so a click becomes an action with no device round trip at all. The action now enters
the timeline and the code immediately and is **retracted** if the driver then refuses it — by identity rather
than by position, since the user can undo or delete something while the device is still answering — with the
refusal stated on screen. Two smaller costs went with it: the hierarchy is no longer re-read before
hit-testing when the client's frame is the device's current one (the tree already in hand _is_ the screen
that was clicked), and the device is looked at immediately after an action as well as after the settle delay,
which is what made a tap take half a second to show any visible effect.

Measured, p50: click → code 1381 ms → 3 ms (Maestro) and 45 ms (Appium); click → the device screen moving
1915 ms → 1510 ms (Maestro) and 194 ms (Appium). The remaining Maestro figure is its own command latency —
each command runs as its own flow over MCP — and nothing on this side removes it. The §11 budget now carries
these numbers and a row for the code latency, which must stay independent of the driver.
