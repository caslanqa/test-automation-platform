---
'@pwtap/platform': minor
---

Add the booted-device registry (`readBootedDevices`/`recordBootedDevice`/`clearBootedDevices`/`stopBootedDevices`), hoisted out of `@pwtap/plugin-maestro` so mobile engines can share it. Tracks the devices a run auto-booted (in a shared tmp file) so a teardown can shut only those down, leaving hand-booted devices untouched; pass `{ keepDevices: true }` to skip the shutdown while still clearing the record.
