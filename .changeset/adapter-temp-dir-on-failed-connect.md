---
'@pwtap/plugin-maestro': patch
'@pwtap/plugin-appium': patch
---

Remove the session temp directory when `connect` fails, not only when a session closes

Both adapters create their evidence directory early in `connect`, before the device, the driver or the app can
refuse — and only a `DriverSession.close()` removed it. A connect that never returned a session therefore left
an empty directory behind every time: a device that went away, a driver that would not start, an app id that
could not be launched. Found by counting: a day of recording and testing on one machine left 22 of them.

Small on its own, and the same rule §11 already sets for frames — nothing this tool creates outlives the launch
that created it.
