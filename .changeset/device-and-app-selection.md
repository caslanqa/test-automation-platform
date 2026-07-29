---
'@pwtap/mobile-core': minor
'@pwtap/plugin-maestro': patch
'@pwtap/plugin-appium': patch
'@pwtap/mobile-inspector': patch
---

Say which device was missing and which ones exist, and let a pinned device be redirected without editing the
test.

A recording pins a device by name so it is reproducible (ADR-003), which means the first thing that happens on
a colleague's laptop or in CI is that the name does not resolve. Both adapters answered
`no android device available to connect the inspector to`: it named neither the device asked for nor the ones
present, said nothing about how to proceed, and mentioned the inspector during a plain test run. It now reads

> [maestro] android device "pixel42" was not found on this machine. Available: pixel9 (booted), galaxy21,
> pixel10, pixel11, pixel8, pixel9b. Point `mobileTarget.device` at one of those, override it with
> MOBILE_INSPECTOR_DEVICE=<name>, or create it in Android Studio > Device Manager, or `avdmanager create avd`.

with the list deduplicated by name and capped, since a machine can carry forty simulators and six of them can
be called "iPhone 17 Pro". Naming no device at all is reported as the different problem it is, rather than
quoting `"undefined"` back.

`MOBILE_INSPECTOR_DEVICE` is new, and closes an asymmetry: `driver`, `platform` and `headless` could all be
redirected from the environment and `device` — the one value that is machine-specific by nature — could not.
It is the one option where the environment WINS over the test, deliberately: which driver and platform are
under test is the test's own meaning and an environment must not quietly change it, whereas a device name is a
fact about one machine, and the alternative to an override is editing every recorded test per machine.

**Also:** the inspector's app-id field now says what it is for. It reads as "the only app I may touch", which
left a journey that starts on the home screen looking impossible; it is neither a restriction nor optional. It
is what the recorded test launches, and Maestro requires one for every command — the app's own scope does not
limit which elements a command may act on, verified on a device by recording home → app drawer → tap the icon →
tap inside the app, all in one session.
