---
'@pwtap/mobile-core': minor
'@pwtap/mobile-inspector': minor
'@pwtap/plugin-maestro': minor
---

Let the recorder connect a Maestro session with no app id — which is every iOS connect

Reported from a live installation: opening the inspector against an iOS simulator with the Maestro driver and
leaving the app-id field empty always failed with

```
connect failed: [maestro-inspector] the Maestro driver scopes every command to one app, and no app id was
given or could be detected on the device — connect with an app id (e.g. com.example.app)
```

"or could be detected" was not true on iOS: nothing was even attempted there. Looking for something to attempt
found nothing usable either — `launchctl list` names every running app rather than the frontmost one,
`simctl appinfo` names none, and the view hierarchy's app label is not dependably present (the same query
returned `"Safari"` once and `undefined` a minute later). Android was only better by luck: connecting while the
device sat on the home screen detected the _launcher_, which Maestro answers with `Unable to launch app
com.google.android.apps.nexuslauncher`, and the connect failed the same way.

The premise was wrong. Maestro does not need an app **id** for every command, it needs a config **header** —
and `appId: any` is a valid one. Verified on a simulator: `tapOn` by point and by selector, `assertVisible`,
`extendedWaitUntil`, `swipe`, `waitForAnimationToEnd` and `back` all run under it.

- **Recording** now attaches to whatever is on screen when no app id was given and none could be detected, via
  the new `ConnectOptions.attachWithoutApp` that only the recorder sets. A _detected_ app id that fails to
  launch degrades the same way, because it was our guess — the home-screen case above now connects instead of
  failing. An app id the caller **named** still throws: getting that wrong is worth hearing about.
- **Replay** keeps the refusal, deliberately. A test that never launches its app and taps whatever happens to
  be in front of it passes or fails for reasons unrelated to the test, so the fixture does not pass the flag and
  gets a message naming what to set.
- A session with no app pinned **says so on screen** through the connection warnings, because the recording is
  real and the generated test still needs an `appId` to run. Codegen emits none rather than `any`, which is a
  header wildcard and not a bundle id anything could launch.

Found while fixing it: the iOS app picker was hiding every system app. A fresh simulator has three user apps
and seventeen system ones, so Settings and Safari — what every mobile example and most first recordings use —
were absent from the list, on the one platform where the app id could not be detected either. Android had
always listed both. The picker now lists them with the user's own apps first.

Also reported and fixed: **the device picker was showing simulators as UDIDs with no name in them.** The label
was built from the handle the picker sends, and iOS sends the UDID — so every row read
`69F9D9B8-CBAA-4D98-94CB-2B91B4EA4BD2`, leaving nothing to choose by. Every row now leads with the device's own
name and keeps a short id after it, because simulator names repeat legally (this machine has five called
"iPhone 17 Pro") and something has to tell them apart. Booted devices are listed first. The value the picker
sends is unchanged, so a recording still pins the durable handle.
