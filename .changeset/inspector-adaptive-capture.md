---
'@pwtap/mobile-inspector': minor
---

Replace the fixed frame poll with an adaptive capture schedule, and finish splitting the engine.

The recorder captured every 1500 ms regardless of anything. On a slow driver that meant overlapping requests
that saturated the device; on a fast one the screen felt stale; and a driver that cannot produce frames
cheaply was polled anyway. Capture now happens on connect, after every action, and — only while idle, and
only when the driver declares `liveFrames` — on an interval of twice the median measured capture time,
clamped to 750 ms…5 s, doubling per consecutive failure up to 30 s (ADR-006).

After an action the screen gets a 250 ms settle and, if it moved, a second look a beat later, so an
animating transition is not recorded as the frame from halfway through it.

`DeviceSession` now owns the device, the lock and the schedule, which completes the split of the engine into
the five owners §6 describes; the coordinator is down from 967 lines to 562.

**Also:** the poll timer is `unref`'d, so a session left connected by a crash can no longer keep the host
process alive forever.
