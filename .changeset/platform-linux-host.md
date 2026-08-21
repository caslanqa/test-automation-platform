---
'@pwtap/platform': minor
'@pwtap/plugin-appium': patch
'@pwtap/plugin-maestro': patch
---

Linux is a supported host for Android, so the emulator can run where a hypervisor exists

`getPlatform()` threw `no Platform implementation for 'linux'` on every non-macOS host, which is what pinned the
nightly Android device job to macOS runners — where it could never work: GitHub's macOS runners are Apple silicon
and expose no hypervisor to the VM, so the emulator died at launch with `HVF error: HV_UNSUPPORTED` for 21
consecutive nightlies. A Linux runner has KVM. So there is now a `LinuxPlatform` next to `MacPlatform`, and
`device.yml` runs Android × {Maestro, Appium} on `ubuntu-latest` with `/dev/kvm` opened to the runner user, while
iOS stays on macOS because simulators exist nowhere else.

Three decisions worth stating:

- **iOS calls on Linux fail, they do not throw.** `simctl` returns a `RunResult` with code 1 and a reason, and the
  Simulator-app helpers no-op. That is what the callers already handle: device discovery and the device/app
  pickers treat a non-zero `simctl` as "no simulators" and stay usable, where a throw would take down a UI that
  was only asking a question.
- **The SDK search is the host's own.** Linux looks at `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `~/Android/Sdk`, then
  `/usr/local/lib/android/sdk` — the last one so `adb` still resolves on a runner image that stops exporting the
  env vars. The macOS location has no business in a Linux search, and vice versa, so what the two hosts share
  (process execution, PATH lookup, SDK tool resolution) now lives in one place instead of being copied.
- **"Install Xcode" is not advice a Linux user can act on**, so both mobile plugins' host checks only warn about
  `xcrun` on macOS.

Two defects fell out of writing the tests for it. A binary that never spawned reported `code: 1` with an **empty**
`stderr` — the rejection carries `stderr: ''`, so `??` never reached the `message` fallback and every
missing-tool failure arrived with no explanation. And `which()` now retries with a bare `which` when
`/usr/bin/which` is absent, because a host without it would otherwise report every tool as missing, which reads
as "adb is not installed" rather than as a host problem.

Verified on a real Linux kernel, not by inspection: the seam's 15 tests pass inside a `node:22-slim` container as
well as on macOS. The emulator legs themselves are verified by the first nightly that runs after this lands.
