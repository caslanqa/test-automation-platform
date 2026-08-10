---
'@pwtap/mobile-core': minor
'@pwtap/mobile-inspector': minor
'@pwtap/plugin-maestro': minor
'@pwtap/plugin-appium': minor
---

Stop paying for work the inspector never needed between a tap and the screen

Reported as "the mobile inspector is slow". Most of the per-tap cost belongs to Maestro — it runs every command
as its own flow and charges roughly 420 ms for the privilege, which nothing on this side removes (re-verified
against Maestro 2.6.1: `run` is still the only interaction tool, and `maestro studio` still has no port flag).
Everything around that floor was ours:

- **Every frame round-tripped through the filesystem.** Both adapters took the base64 the driver already
  returned, decoded it, wrote a file, read the file back and encoded it again — and neither ever emptied the
  temp directory, so a ten-minute session at one frame per 750 ms left hundreds of screenshots on disk against
  a documented budget of three. Live frames now write no file, and the directory is removed on close.
  `screenshot`/`aiAssert` and failure evidence still write files, because a file is what those are for.
  Measured on a device, this is a **disk** fix rather than a latency one: `takeScreenshot()` against
  `saveScreenshot()` + `readFile` is 488 ms vs 485 ms p50, indistinguishable next to the driver's own
  screenshot call — but the old path wrote ~1 MB per poll tick and never deleted any of it.
- **Every action settled three times.** The engine captured, slept 250 ms, read the hierarchy, captured again,
  and — if that frame differed from the one taken _before_ the sleep — slept and did it all again. A tap always
  looks different a beat later, so the third pass ran essentially always. `ActionResult.settled` (new, optional)
  lets a driver say it already waited: Maestro now sends `waitForAnimationToEnd` inside the same `run` call, so
  one look finishes the job. A driver that cannot promise it keeps a two-look schedule, now comparing the two
  _settled_ captures rather than one taken mid-animation. Either way the hierarchy is read once, at the end,
  instead of twice — once mid-animation, where it was stale before it arrived.
- **`fill` cost two Maestro calls.** Maestro has no "fill this field" primitive, so it is a tap plus an
  `inputText` — sent as two `run` calls, paying that ~420 ms twice for one recorded step. `run` accepts a
  multi-line flow, so both lines now travel in one call.
- **An idle poll read the whole hierarchy.** The poll asks one question — did the screen move? — and the frame
  answers it. The tree is now read only when the frame's bytes changed, which on Maestro takes ~110 ms of the
  device's attention per tick out of the queue the user's next interaction waits in.
- **An unchanged tree was re-sent anyway.** Frames were deduplicated and hierarchies were not, so an idle
  device had the browser rebuild its whole accessibility view on every tick. Identical trees are now dropped
  the way identical frames already were, and the tree renders three levels deep instead of every node — a
  native screen is several hundred rows, mostly anonymous layout containers.
- **The once-per-session locator check was awaited.** `verifyStrategies` issues a real `isVisible` query with a
  2 s bound; awaiting it added that to the first interaction using each strategy, which the spec had already
  ruled out. It now runs unawaited, and not at all for an interaction that was not recorded.
- **Appium asked for the window size once per frame.** A WebDriver round trip for a number that only changes on
  rotation, which `orientCoordinateSpace` (new, shared) derives from the image instead.

The hover highlight is also throttled to one hit-test per animation frame and only re-renders when the element
under the pointer actually changes; it walked the entire tree on every mousemove event before.

Measured on an Android emulator, p50 of five samples: **click → screen moves on Maestro is 1510 ms → 896 ms.**
Appium is unchanged within emulator variance, which is expected — it reports no `settled` and its per-command
cost was never the problem. The device-gated test now prints these numbers so the next change to the schedule
can be checked rather than argued about.
