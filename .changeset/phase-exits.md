---
'@pwtap/mobile-inspector': patch
---

Close the Phase 2 and Phase 3 exit gates, and fix two defects in the device workflow that were making it
report success it had not earned.

**200 interactions drop nothing.** The gate Phase 2 was waiting on, now a test: identical taps, a mixed script
of every recordable kind, and undo/redo across a hundred steps — all with the frame schedule running
underneath, so most interactions arrive against a frame that has already moved. Verified to have teeth by
reinstating the old frame-staleness rejection, which fails all three. `RecorderSession` takes optional capture
timing so 200 rounds cost 250 ms instead of the real settle delay each.

**Idle CPU measured:** 0.17 % of one core for Maestro and 1.56 % for Appium over 30 s connected and untouched,
against a 5 % budget, with the adaptive schedule settling to about one frame per second. §11 also gains the
device floor for context — a raw `adb shell input tap` is 42 ms and `adb exec-out screencap` 120 ms on the
same emulator — which is what places Appium within a hair of the hardware and Maestro's remaining ~420 ms
squarely in its MCP surface.

**The device workflow could not have passed.** Its Android job ran on a Linux runner, and `@pwtap/platform`
implements macOS only, so the first nightly run failed with `no Platform implementation for 'linux'` — as it
always would have. Android now runs on macOS too (arm64 image to match the runner), which keeps CI on the one
host the product supports; a `linux.ts` remains the alternative and is a product decision. Worse, the iOS job
never booted a simulator, and the device test deliberately asserts against a device someone else booted, so it
SKIPPED — a green run with the gate doing nothing. It boots one now.

All four combinations were driven end-to-end on real devices by hand as well: connect, record, reload
mid-session, record again, save, run.
