---
'@pwtap/platform': patch
'@pwtap/mobile-core': patch
'@pwtap/mobile-inspector': patch
---

Fix the two defects reported from a real installation: taps that never became code, and a generated test
that could not find its device.

**A reloaded page recorded nothing.** The command envelope's sequence guard was scoped to the launch while a
browser counts from 1 on every page load, so after a reload every command came back `409 command 1 arrived
after 5`. Frames need no command, so the device screen kept updating and the UI looked perfectly alive while
each click was silently refused — on both drivers and both platforms, because the defect is in the transport.
`seq` is now reset on attach: ordering only ever needed to hold within one client's own stream of POSTs.

**The generated test pinned the adb serial.** The device picker sends the serial, which is the only handle
that addresses a live emulator, and two things then failed to turn it back into the durable AVD name:
`findBootedAndroid` wrote the caller's own input (or the serial) into `DiscoveredDevice.name`, a field
documented as the AVD name, and `resolveStableDeviceName` never consulted the device list it is handed —
where the serial→AVD mapping was sitting all along. A recording therefore produced
`device: "emulator-5554"`, which fails with `no android device available to connect the inspector to` once
that emulator instance is gone. Both are fixed, and the same recording now pins `pixel9` and replays.

**A second view is no longer refused.** `mobile-inspect` opens a window _and_ prints the URL, so opening
that URL — which the README invites — got a 409, and an `EventSource` that receives a non-200 never retries:
the page rendered and stayed deaf. The newest view now takes over, the displaced one is told and closes its
own stream (a server-side close would read as a retryable drop and the two would displace each other
forever), and either can take it back.

**A refused action is now stated on screen.** An action the driver rejects is deliberately not recorded, but
the reason lived only in a log tab the user had to know to open, so a click that produced nothing looked like
a bug in the recorder. It now says which action was refused and why.
