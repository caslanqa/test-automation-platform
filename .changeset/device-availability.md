---
'@pwtap/mobile-core': minor
'@pwtap/mobile-inspector': minor
'@pwtap/plugin-maestro': minor
'@pwtap/plugin-appium': minor
---

Stop a device the machine does not have from failing a run, and stop the picker from describing a machine that
has moved on

Reported as "the test blows up when the devices on the machine are out of sync with the framework". Two
independent causes, at the two ends of a recording's life.

**On replay.** A recording pins a device by name so it is reproducible, which means the very first thing that
happens on a colleague's laptop or in CI is that the name does not resolve. The `maestro` and `appium` fixtures
have always answered that with a skip that states the reason; the `mobileApp` fixture — the one every
inspector-generated test uses — threw instead, so sharing a recorded test failed the build. The adapters now
throw `DeviceUnavailableError` (new export) for exactly this case and the fixture skips with the reason,
which reaches both the terminal and the report. Every other connect failure — a missing CLI, a broken Appium
server — still fails the test, because those are defects rather than facts about the host.

**While recording.** The device list was read once, when a driver was picked, and never again — so booting or
killing an emulator afterwards left the picker offering something that no longer existed, and connecting to it
failed. It is now re-read whenever the panel opens, after any failed connect, and on a Refresh button. Three
more, found in the same area:

- Switching platform kept the selected device, so an Android serial could be sent as an iOS simulator name.
- A failed connect never cleared the "connecting" state: the button stayed disabled, reading `Connecting…`,
  permanently — and a stale device list is the most likely way to get there.
- The picker sent a booted emulator's `adb` serial and relied on the resolver mapping it back to the AVD name
  before codegen. It now sends the AVD name, which addresses a live emulator just as well and survives a
  reboot. When only a serial is known, the picker says so where the choice is made, and the resulting
  "this will not match after a reboot" warning is a banner rather than a line in a log tab.

Connecting also reports what it is doing (`ConnectOptions.onProgress`, new and optional): acquiring or booting
the device, installing a build, starting the driver, launching the app, reading the first screen. It reported
one word for all of it, so a slow boot and a hung driver looked identical and users restarted sessions that
were working.
