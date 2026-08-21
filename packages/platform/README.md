# @pwtap/platform

**Platform seam** for [Playwright Test Automation Platform](https://www.npmjs.com/package/@pwtap/create) plugins — one place for OS paths, shell, device discovery/boot, and a cross-process device lock. macOS drives Android and iOS; Linux drives Android.

[![npm](https://img.shields.io/npm/v/@pwtap/platform)](https://www.npmjs.com/package/@pwtap/platform)

> You normally **don't install this directly.** It arrives as a runtime dependency of the plugins that need device/OS access (e.g. the mobile engines). Start a project with `npm init @pwtap@latest`.

## Why

Every OS-specific command (Android SDK paths, `adb`, `simctl`, emulator boot, device locking) lives behind one interface, so engines stay OS-agnostic and new platforms are additive rather than scattered `if (process.platform)` branches.

```ts
import { getPlatform } from '@pwtap/platform';

const platform = getPlatform(); // MacPlatform or LinuxPlatform; throws elsewhere, naming the file to add
platform.os; // 'macos' | 'linux'
```

## Surface

- `getPlatform()` → `Platform` (paths + shell helpers).
- Device discovery + boot for Android AVDs and iOS simulators.
- `deviceLock` — an OS-agnostic cross-process lock so two runs never boot or claim the same device.

macOS and Linux are implemented; other OSes throw a clear "add this file" error rather than silently misbehaving. A Linux host answers iOS calls with a failed `RunResult` instead of throwing, so device discovery and the device/app pickers report "no simulators" and stay usable — that is what runs the Android emulator on a CI runner with KVM, where a macOS runner has no hypervisor to give it.

## License

MIT
