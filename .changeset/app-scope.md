---
'@pwtap/platform': minor
'@pwtap/mobile-core': minor
'@pwtap/plugin-maestro': patch
'@pwtap/mobile-inspector': patch
---

Never hand back a Maestro session that cannot perform anything.

Maestro scopes every command — including `tap` and `back` — to one app, and refuses until one is set. The
adapter only set it when the caller named an app, so connecting with an empty app id produced a session that
showed the screen, listed the hierarchy, and failed every single interaction with
`[maestro] call maestro.launchApp(appId) before other commands`: an internal API instruction, surfaced on
every click, with nothing recorded.

The driver now resolves an app itself. The foreground app is what the user is looking at, so it is the one
they mean: `@pwtap/platform` gains `foregroundAndroidApp()`, and the adapter adopts it. When no app can be
determined it refuses the connection outright, naming what to supply, instead of connecting into a state where
nothing works.

Whatever it resolves is reported back on the session (`DriverSession.appId`, optional so adapters that always
require an explicit id are unaffected) and is what codegen pins — a recording that pinned nothing would launch
nothing on replay and re-record against whatever happened to be open.
