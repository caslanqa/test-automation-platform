---
'@pwtap/mobile-core': patch
---

Make the device-unavailable message testable without the machine deciding the branch

`deviceUnavailableMessage` says something different depending on whether this machine has any devices, and its
test forced the empty branch by setting `PATH=/nonexistent`. That stubbed nothing: the emulator is invoked by
absolute path inside the Android SDK, so the branch under test was whichever one the developer's machine produced.
On a laptop with AVDs the message listed them and the assertions passed; in CI there are none, the other branch
ran, and every run failed for a week while `npm test` was green locally.

The device list is an optional injected parameter now, defaulting to real discovery, so both branches are covered
deterministically — including that the no-devices branch does NOT offer `MOBILE_INSPECTOR_DEVICE`, which would be
advice that cannot work when there is no device to name.
