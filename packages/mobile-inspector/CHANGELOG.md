# @pwtap/mobile-inspector

## 2.3.0

### Minor Changes

- 5674df5: A mobile MCP server: nine tools, no SDK, and one capability an agent cannot get from the shell

  pwtap consumed MCP before it served it — `plugin-maestro` has driven `maestro mcp` through a hand-written
  JSON-RPC client since the beginning. `@pwtap/mobile-inspector` now ships the other half: `mobile-mcp`, a
  stdio server exposing the mobile platform to any MCP client.

  **It exists for one tool.** `mobile_locators` returns ranked, uniqueness-checked, fragility-annotated
  locator candidates — scored 0-100 for stability, checked against the live tree, with a −25 penalty for a
  non-unique match, −60 for an element outside the app under test, an index fallback for a repeated row, and
  coordinates last and always flagged. No shell command produces that; `adb shell uiautomator dump` gives
  raw XML with no scoring. Without it, an agent writing a mobile test writes coordinate taps. It also needs
  the state a CLI cannot hold: Maestro costs ~420 ms per command plus driver boot, Appium builds WDA on the
  first session, and a warm session between tool calls is the difference.

  **Three servers were considered and killed.** A run/triage server: `playwright test --reporter=json` is a
  shell command and the reports are files, which an agent reads with a bounded `Read` instead of dumping a
  blob into context — which is also why this phase has **no dependency on the healing engine**. A separate
  codegen server: it needs the connected session's target header, so it folds in as `mobile_codegen`. A
  judge server: the client is already an LLM, and the judge's entire value is being a deterministic,
  cached, kappa-calibrated CI gate — none of which survives an ad hoc chat call.

  **We do not ship `@playwright/mcp` or `maestro mcp` in our own configuration either.** The second is
  actively harmful: `McpClient.close()` documents that two `maestro mcp` processes on one device collide and
  the driver dies with `Failed to connect to 127.0.0.1:<port>`, which is exactly what the fixture's device
  lock prevents. Handing an agent a second, unlocked one would guarantee the collision it was written to
  avoid. Our server goes through `driver.connect()`, and therefore through the lock — the whole reason to
  write one.

  **Hand-rolled, no SDK (ADR-015).** Both generations force `zod`: v2 depends on it, v1 has it as a
  non-optional peer. That is ~11.6 MB of closure added to a package shipping 1.15 MB against a 5 MB budget,
  and v1 additionally brings `express`, `hono`, `cors`, `jose` and an OAuth stack to run a stdio server.
  Against ~120 lines whose inverse this repo already ships and has debugged. `nfr-check` now bans `zod` and
  both SDKs — and that check had to be extended, because `mobile-inspector` is dev-only and therefore
  excluded from the runtime closure scan, so an SDK added there would have passed silently.

  The protocol version is pinned to `2025-06-18` rather than tracking the newest: `2026-07-28` adds a
  `resultType` field servers MUST send, and advertising a version whose MUSTs we do not meet is worse than
  being behind.

  **Security, where the argument is about names rather than arguments.** An MCP tool is approved by name,
  once, and then called with whatever a model produced from a screen it read. So: no shell, `adb`, `simctl`,
  uninstall or erase tool exists at all — one allowed once is a permanent unaudited escape from the user's
  own Bash gate, which does see the real command string. The action IR is closed and validated by the
  **same** narrowers the SSE boundary uses, so the two cannot drift. `locator.native` is rejected here even
  though `isLocator` allows it, because an adapter escape hatch is right for a human writing a test and
  wrong for a model-supplied XPath. `PWTAP_MCP_ALLOW_ACTIONS` defaults to off and `mobile_perform` stays
  _listed_ while refusing — hiding it pushes a model to invent `adb shell input tap` instead of asking a
  human. Screens and trees are wrapped in `<device-material-NONCE>` with a fresh nonce per call, bounded by
  `maxDepth`/`maxItems`, and `mobile_screen` returns a file path by default because a screenshot of a
  logged-in app is a credential.

  `env/environments.json` never reaches the server, and not by discipline: `config/loadEnv.ts` is a
  core-template file called from a scaffolded project's Playwright config, and nothing in `mobile-inspector`
  or `mobile-core` reads it. The only thing that would break that is a tool spawning Playwright — the run
  tool we killed.

  **Two supporting changes, both useful on their own.** `acquireDeviceLock` takes a `timeoutMs`, and
  `ConnectOptions` forwards one: `mobile_connect` waits two minutes rather than the platform's thirty,
  because a tool call blocked for half an hour is indistinguishable from a hang and cannot be cancelled.
  Fixed in the shared function rather than by racing and abandoning in the caller, which leaks the lock when
  the abandoned attempt later succeeds. `MOBILE_CORE_CONTRACT` stays at 1 — an added optional field cannot
  break an older adapter, and bumping it would break every adapter's build to announce a change none of them
  need. `service/protocol.ts` exports its narrowers, and `McpClient.request` becomes public so our own
  client can drive our own server in the smoke rather than a second one written for the test.

  **A defect the tests caught while it was being built:** `session.require()` threw straight out of the
  dispatcher, turning "not connected" into a JSON-RPC transport error. A tool result is something a model can
  read and act on; a transport error is one it can only report. Every tool now returns `isError: true`
  instead, and nothing can take the channel down.

  `npx @pwtap/create mcp` prints a configuration block and **never writes one**. A `.mcp.json` we generated
  would be a file we own forever in someone else's repository, needing a removal path, an idempotence test
  and a marker region to be safe. It points at the project's own installed inspector rather than `npx`,
  because a globally npx-ed copy running against this project's adapters is the version skew ADR-009 refuses.

  **Distribution is derived, not injected.** A plugin declares its server in its manifest
  (`mcp: [{ name, package, entry, shared }]`) and the rendered Claude Code plugin emits `.mcp.json` from
  whatever resolves in the client's `node_modules`. So installing a mobile plugin gives an agent the mobile
  tools, removing it takes them away, and there is nothing in the user's repository to undo — no marker
  region, no removal path, no idempotence test. `shared: true` keeps the entry when one mobile plugin is
  removed and the other stays. Three settings come from the plugin's `userConfig`: `ALLOW_ACTIONS` (off by
  default), `IDLE_MS` and `DEVICE`.

  **One trap, found by rendering against a real installed project rather than by reasoning about the
  resolver.** The first existence probe asked for `<pkg>/package.json`, and a package with an `exports` map
  does not export its own manifest — so it failed with `ERR_PACKAGE_PATH_NOT_EXPORTED` for precisely the
  packages that are correctly configured. The smoke missed it too, because its fake package had no `exports`
  map; it has one now, and reverting the fix makes the smoke fail.

### Patch Changes

- Updated dependencies [f17184c]
- Updated dependencies [5674df5]
- Updated dependencies [d9d214a]
  - @pwtap/mobile-core@1.4.0
  - @pwtap/platform@1.2.0

## 2.2.0

### Minor Changes

- 2065647: Stop a device the machine does not have from failing a run, and stop the picker from describing a machine that
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

- 2065647: Stop paying for work the inspector never needed between a tap and the screen

  Reported as "the mobile inspector is slow". Most of the per-tap cost belongs to Maestro — it runs every command
  as its own flow and charges roughly 420 ms for the privilege, which nothing on this side removes (re-verified
  against Maestro 2.6.1: `run` is still the only interaction tool, and `maestro studio` still has no port flag).
  Everything around that floor was ours:

  - **Every frame round-tripped through the filesystem.** Both adapters took the base64 the driver already
    returned, decoded it, wrote a file, read the file back and encoded it again — and neither ever emptied the
    temp directory, so a ten-minute session at one frame per 750 ms left hundreds of screenshots on disk against
    a documented budget of three. Live frames now write no file, and the directory is removed on close.
    `screenshot`/`aiAssert` and failure evidence still write files, because a file is what those are for.
    Measured on a device, this is a **disk** fix rather than a latency one: `takeScreenshot()` against
    `saveScreenshot()` + `readFile` is 488 ms vs 485 ms p50, indistinguishable next to the driver's own
    screenshot call — but the old path wrote ~1 MB per poll tick and never deleted any of it.
  - **Every action settled three times.** The engine captured, slept 250 ms, read the hierarchy, captured again,
    and — if that frame differed from the one taken _before_ the sleep — slept and did it all again. A tap always
    looks different a beat later, so the third pass ran essentially always. `ActionResult.settled` (new, optional)
    lets a driver say it already waited: Maestro now sends `waitForAnimationToEnd` inside the same `run` call, so
    one look finishes the job. A driver that cannot promise it keeps a two-look schedule, now comparing the two
    _settled_ captures rather than one taken mid-animation. Either way the hierarchy is read once, at the end,
    instead of twice — once mid-animation, where it was stale before it arrived.
  - **`fill` cost two Maestro calls.** Maestro has no "fill this field" primitive, so it is a tap plus an
    `inputText` — sent as two `run` calls, paying that ~420 ms twice for one recorded step. `run` accepts a
    multi-line flow, so both lines now travel in one call.
  - **An idle poll read the whole hierarchy.** The poll asks one question — did the screen move? — and the frame
    answers it. The tree is now read only when the frame's bytes changed, which on Maestro takes ~110 ms of the
    device's attention per tick out of the queue the user's next interaction waits in.
  - **An unchanged tree was re-sent anyway.** Frames were deduplicated and hierarchies were not, so an idle
    device had the browser rebuild its whole accessibility view on every tick. Identical trees are now dropped
    the way identical frames already were, and the tree renders three levels deep instead of every node — a
    native screen is several hundred rows, mostly anonymous layout containers.
  - **The once-per-session locator check was awaited.** `verifyStrategies` issues a real `isVisible` query with a
    2 s bound; awaiting it added that to the first interaction using each strategy, which the spec had already
    ruled out. It now runs unawaited, and not at all for an interaction that was not recorded.
  - **Appium asked for the window size once per frame.** A WebDriver round trip for a number that only changes on
    rotation, which `orientCoordinateSpace` (new, shared) derives from the image instead.

  The hover highlight is also throttled to one hit-test per animation frame and only re-renders when the element
  under the pointer actually changes; it walked the entire tree on every mousemove event before.

  Measured on an Android emulator, p50 of five samples: **click → screen moves on Maestro is 1510 ms → 896 ms.**
  Appium is unchanged within emulator variance, which is expected — it reports no `settled` and its per-command
  cost was never the problem. The device-gated test now prints these numbers so the next change to the schedule
  can be checked rather than argued about.

- 2065647: Recording is now an explicit act, and the element menu can express what the IR always could

  **Every click used to become a test step.** The viewport is also how you reach the screen you came to record,
  so a recording began with the whole trip there, to be deleted by hand afterwards. A plain click now drives the
  device and records nothing; **⌘/Ctrl + click records**. A `Record` toggle inverts the default — and is the
  keyboard-reachable equivalent, since a modifier-click is mouse-only — and holding the modifier always means
  "do the other thing, once". Choosing a locator from the context menu still records unconditionally: picking one
  from a list is the explicit act. Navigation is now also cheaper than recording, because it skips codegen, the
  draft update and the locator-strategy check entirely.

  **The context menu offered five of the fifteen actions the IR has.** It now covers tap, fill, long press, wait,
  assert visible / not visible, is visible, screenshot and an AI-rubric assertion, plus scrolling inside the
  chosen element, "copy as code", "reveal in tree", and a checkbox to write a step down _without_ running it —
  which was previously hard-wired for `assertNotVisible` alone and unavailable for anything else.

  **`back` and `pressKey` had no way into a recording at all** — both are in the IR and supported by both drivers,
  but neither the screen nor an element menu can express "press Home". A small toolbar under the viewport carries
  Back / Home / Enter / Screenshot, under the same record gate.

  **The element's own attributes are shown.** The ranked candidates say how to address an element; class, text,
  accessibility id, resource id, owning package and bounds say whether it is the element you meant. They arrived
  with every hit-test already and the UI dropped them.

  **The editor completes from the device**: `mobileApp`'s methods, and locator literals built from the live
  hierarchy. Reading an id off the tree panel and typing it back is exactly where a typo becomes a locator that
  never matches. The method list is a total `Record` over `keyof MobileApp`, so a method added to the facade
  fails the UI type-check until it is listed — the hand-maintained version drifted inside a single release.

  **The timeline is walkable.** Each recorded step remembers the frame the screen showed once it had run, so
  clicking a step shows that screen; a pinned step is read-only, because coordinates on a past screen do not
  address the live one. Steps also carry a stable id now, which is what makes a step identifiable at all —
  retracting a refused action had to match by object identity before. Retention is bounded at 50 step frames
  (~7 MB) and a step whose frame has aged out says so instead of rendering blank.

- 79f02d5: Keep the launch token out of printed output and off disk

  `mobile-inspect` printed `http://127.0.0.1:<port>/?token=<secret>` on every launch. That token authorises a
  service which spawns processes and writes files inside the project, and printed output is the least private
  place there is: terminal scrollback, a screenshot, a pasted log, a recorded pairing session. It was also
  stored in the single-instance lock file under `node_modules`, world-readable, for the length of the session.

  Neither was necessary:

  - **The window carries the token in an `x-inspector-token` header**, set on the Playwright browser context, so
    it covers the navigation and every subresource — the page, the bundle, the event stream, each frame. The
    launch now prints `http://127.0.0.1:<port>` and nothing else. The token no longer appears in printed output,
    in the page's own `location`, or in the browser profile, and it was already kept out of `ps` by navigating
    after launch rather than passing `--app=<url>`.
  - **The lock file holds port and pid only.** It carried the token so a second launch could quote a
    ready-to-open URL; a port and a pid are enough to say "that one is running, use it or stop it".
  - **`?token=` still works**, because a browser this process did not launch cannot be given a header. That URL
    is printed only when no window could be opened, and the line says it contains a secret. The cookie the first
    such request sets is unchanged, so the hand-opened path keeps working for assets, events and frames.

  Duplicate `x-inspector-token` headers are refused rather than resolved — Node folds them into one
  comma-separated value, and accepting a prefix would let a caller append a guess to a real token.

  Nothing to change in a project: `npm run mobile:inspect` behaves the same, minus the secret in the log. Anyone
  scripting against `startInspectorService()` gets a new token-free `origin` on the handle; `url` still carries
  the query token and now documents when using it is appropriate.

- 2065647: Four actions the drivers could always do, and the ordinal a list row needs

  **`doubleTap`, `eraseText`, `hideKeyboard`, `scrollUntilVisible`.** All four were reachable from the Maestro
  session layer already and absent from the action IR, so no recording could contain one and no generated test
  could call one — a flow that clears a field and scrolls to a row forty items down had to be finished by hand.
  Both adapters implement all four; the two that needed care are worth stating:

  - `eraseText` clears the whole field by default and takes `characters` for a partial erase. Maestro's own
    command acts on the focused field, so the adapter taps and erases in one call; Appium's `clearValue` can
    only empty a field, so a partial erase is that many backspaces to the focused element instead of pretending.
    The iOS run caught the obvious form of those backspaces being Android-only: `keys(''.repeat(n))` works on
    UiAutomator2 and WebDriverAgent answers `Key Down action '' must have a closing Key Up successor`, so the
    key down/up pairs are built explicitly. Verified by observation where the value is visible —
    `"abcdefgh"` → `"abcde"` on Android, `"example"` → `"exam"` on iOS through Maestro.
  - `scrollUntilVisible` is a Maestro primitive and a bounded look-then-scroll loop on Appium, with the timeout
    in `ACTION_DEFAULTS` rather than invented inside the adapter. The platform-specific alternatives were both
    narrower: `UiScrollable().scrollIntoView` only accepts a `UiSelector`, so an accessibility-id locator could
    not use it, and iOS's predicate scroll needs a container element a recording does not have. Running it on a
    device caught the first version dropping `timeoutMs` on Maestro — a four-second budget spent twenty seconds
    looking — which is the silent-substitution §5 forbids; the timeout is forwarded to Maestro's own `timeout`.

  **`MobileLocator.index`** — 0-based, selects among the matches. This is the case where the locator engine had
  nothing good to offer: in a repeated list row every attribute is non-unique, so the text lost 25 points and
  the only thing ranked below it was a raw coordinate. The engine now adds an ordinal candidate at `base − 10`
  — under anything genuinely unique, over the coordinate it replaces — and says that reordering the list changes
  what it resolves to. Both drivers express it natively (Maestro's `index`, WebdriverIO's match list), so it
  stays portable; Maestro's relational selectors (`childOf`, `containsChild`) would not, and are deliberately
  left to `native`.

  `@pwtap/mobile-core`'s README documented `{ text: 'Log in', index: 1 }` before the field existed. It does now.

  Adapters implementing `MobileInspectorDriver` need no change: `DriverCapabilities.gestures` is a partial
  record, so an adapter that does not list the new kinds simply reports nothing for them and the UI leaves the
  controls enabled until the driver refuses one — the same behaviour as before this release.

- b75229a: Let the recorder connect a Maestro session with no app id — which is every iOS connect

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

### Patch Changes

- Updated dependencies [2065647]
- Updated dependencies [2065647]
- Updated dependencies [2065647]
- Updated dependencies [b75229a]
  - @pwtap/mobile-core@1.3.0

## 2.1.1

### Patch Changes

- 2c14d14: A recorded drag carries how far the finger travelled.

  §9 required it and the UI never did: every drag collapsed into a direction-only full-screen swipe, so a short
  flick and a long pull recorded identically and the generated test scrolled a different amount than the user
  had. It sends the measured fraction of the swept axis now — possible only because `SwipeOptions.distance`, dead
  in both adapters until the adapter audit, is honoured.

  The start point is still not carried, and §9 says so rather than claiming the item closed: a swipe beginning
  near the top edge can mean something different from one beginning mid-screen.

## 2.1.0

### Minor Changes

- 7353761: Show the recorded action immediately instead of waiting for the device: click → code drops from ~1.4 s to
  ~3 ms.

  Reported from a live installation as 2–3 s of lag on every interaction. Measured on an Android emulator, the
  whole cost was the driver's own tap — 1258 ms for Maestro, 75 ms for Appium — and the recorder was waiting
  for it before showing anything, because the action was recorded only once the driver confirmed.

  Hit-testing is local, so a click becomes an action with no device round trip at all. The action now enters
  the timeline and the code immediately and is **retracted** if the driver then refuses it — by identity rather
  than by position, since the user can undo or delete something while the device is still answering — with the
  refusal stated on screen. Two smaller costs went with it: the hierarchy is no longer re-read before
  hit-testing when the client's frame is the device's current one (the tree already in hand _is_ the screen
  that was clicked), and the device is looked at immediately after an action as well as after the settle delay,
  which is what made a tap take half a second to show any visible effect.

  Measured, p50: click → code 1381 ms → 3 ms (Maestro) and 45 ms (Appium); click → the device screen moving
  1915 ms → 1510 ms (Maestro) and 194 ms (Appium). The remaining Maestro figure is its own command latency —
  each command runs as its own flow over MCP — and nothing on this side removes it. The §11 budget now carries
  these numbers and a row for the code latency, which must stay independent of the driver.

### Patch Changes

- 766def0: Audit the two driver adapters: four defects where the driver-neutral contract was neutral in name only.

  **The same test behaved differently on each driver.** Every action option is optional, and each adapter
  invented its own default for the ones a test omitted — `isVisible` waited 2 s on Maestro and 5 s on Appium,
  `longPress` held 1 s on Appium and whatever Maestro chose. A test written once and run on both, which is the
  entire promise, could pass on one and fail on the other purely on timing. The defaults now live in the
  contract (`ACTION_DEFAULTS` in `@pwtap/mobile-core`) and both adapters resolve from there. `isVisible` stays
  short and `waitFor` gets Playwright's own 5 s, because they are asked different questions.

  **`SwipeOptions.distance` did nothing at all.** Declared in the IR, exposed by the fixture, and read by
  neither adapter — so `swipe('up', { distance: 0.3 })` silently swiped the full screen on both drivers. It is
  now honoured: as `percent` on Appium/Android and as start/end percentage points on Maestro, whose
  direction-only swipe has no distance of its own. XCUITest swipes by direction only, so Appium/iOS refuses a
  requested distance instead of swiping a different amount and calling it done.

  **Maestro discarded `longPress`'s `durationMs`.** Its own `longPressOn` takes the same properties as `tapOn`
  and no duration (confirmed against Maestro's cheat sheet), so a recorded 3-second press was never one. It now
  refuses, the way `scroll` already refused `within`.

  **The capability matrix lied on iOS.** `MobileInspectorDriver.capabilities` is one static answer given before
  a platform is known, so the Appium driver declared `back: true` and then threw `"back" has no iOS equivalent`
  — which left the inspector offering a Back button that always failed and the fixture's support check passing.
  A session may now narrow the declaration for the platform it connected to (`DriverSession.capabilities`,
  optional, so no contract bump), and the fixture and the UI both prefer it.

  Verified on real devices: Appium/iOS reports `back: false` where the driver still declares `true`, a distance
  swipe is honoured on Maestro and Appium/Android and refused on Appium/iOS, and a `longPress` with a duration
  is refused on Maestro rather than quietly held for the wrong time.

- f132819: Never hand back a Maestro session that cannot perform anything.

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

- 15d477d: Settle the deferred decisions, and stop settling the screen after actions that cannot change it.

  **`native` locators: hand-authored only, never ranked.** A native selector is specific to one driver on one
  platform by definition, so emitting one from the recorder would produce a recording that replays only under the
  driver that made it — the opposite of the premise the whole IR rests on. `MobileLocator.native` stays as the
  escape hatch for what the IR cannot express, and both adapters pass it through untouched.
  `LocatorCandidate.strategy` no longer lists `native`: the engine never produced it, and a type promising a case
  that cannot happen forces dead branches on every consumer.

  **Frame re-encoding: not needed.** Measured at ~150 KB per capture against a 2 MB budget.

  **A read-only action no longer settles the screen.** Every successful action paid a settle — a sleep, a
  hierarchy re-read and up to two captures — including `assertVisible`, `assertNotVisible`, `isVisible` and
  `screenshot`, none of which can change what is on screen. Since commands run one at a time, that was also delay
  in front of whatever the user did next.

  **A run announced as finished had not necessarily cleaned up.** The temp file's removal was fired off unawaited
  and `runStatus: finished` was emitted immediately, so a client told the run had ended could still see the file —
  the opposite of what §11 promises. It is awaited now. This had been showing up as a test that failed only under
  load, three times across one session; it was a real ordering bug wearing a flaky test's clothes.

  Two options were measured and declined rather than left vague, both recorded in §14 with their numbers:
  capturing frames through `adb` instead of the driver (181 → 130 ms, but a second Android-only capture path in
  the layer that has already produced two field defects, for ~8 % of click→screen), and driving Maestro's own
  daemon the way Studio does (~420 ms per tap, but an interface Maestro neither documents nor exposes a port
  flag for, so we would own every break — while Appium is one option away at 194 ms).

- 452ced5: Say which device was missing and which ones exist, and let a pinned device be redirected without editing the
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

- bb09e7d: Fix the two defects reported from a real installation: taps that never became code, and a generated test
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

  **And a test layer that would have caught all of it.** The suite had no UI row: the service tests speak the
  protocol correctly by construction and the engine tests never load a page, so the seam where both defects
  lived was untested. Four tests now drive the real page in a real browser against the fake driver — reload
  keeps recording, the picker's serial still becomes an AVD name in codegen, a refused action is stated on
  screen, and a second view takes over instead of going deaf. Each was checked against the unfixed code first;
  the AVD-name one fails with exactly the `device: "emulator-5554"` seen in the field. CI installs Chromium so
  they cannot silently skip.

- b23c454: Close the Phase 2 and Phase 3 exit gates, and fix two defects in the device workflow that were making it
  report success it had not earned.

  **200 interactions drop nothing.** The gate Phase 2 was waiting on, now a test: identical taps, a mixed script
  of every recordable kind, and undo/redo across a hundred steps — all with the frame schedule running
  underneath, so most interactions arrive against a frame that has already moved. Verified to have teeth by
  reinstating the old frame-staleness rejection, which fails all three. `RecorderSession` takes optional capture
  timing so 200 rounds cost 250 ms instead of the real settle delay each.

  **Idle CPU measured:** 0.17 % of one core for Maestro and 1.56 % for Appium over 30 s connected and untouched,
  against a 5 % budget, with the adaptive schedule settling to about one frame per second. §11 also gains the
  device floor for context — a raw `adb shell input tap` is 42 ms and `adb exec-out screencap` 120 ms on the
  same emulator — which is what places Appium within a hair of the hardware and Maestro's remaining ~420 ms
  squarely in its MCP surface.

  **The device workflow could not have passed.** Its Android job ran on a Linux runner, and `@pwtap/platform`
  implements macOS only, so the first nightly run failed with `no Platform implementation for 'linux'` — as it
  always would have. Android now runs on macOS too (arm64 image to match the runner), which keeps CI on the one
  host the product supports; a `linux.ts` remains the alternative and is a product decision. Worse, the iOS job
  never booted a simulator, and the device test deliberately asserts against a device someone else booted, so it
  SKIPPED — a green run with the gate doing nothing. It boots one now.

  All four combinations were driven end-to-end on real devices by hand as well: connect, record, reload
  mid-session, record again, save, run.

- Updated dependencies [766def0]
- Updated dependencies [f132819]
- Updated dependencies [15d477d]
- Updated dependencies [452ced5]
- Updated dependencies [bb09e7d]
  - @pwtap/mobile-core@1.2.0
  - @pwtap/platform@1.1.0

## 2.0.0

### Major Changes

- eb8214e: Make the Mobile Inspector produce tests that actually run.

  Recording, saving and replaying a mobile flow never worked end to end: the generated test imported a
  fixture nobody wired into the `@fixtures` barrel, omitted the `platform` and `appId` needed to connect,
  pinned an `adb` serial that dies on reboot, ran under the browser project, and asserted visibility through
  an action that could only ever throw. This closes that loop, verified on real Android emulators and iOS
  simulators with both drivers. See `docs/mobile-inspector/architecture.md` for the full design and the
  decision record.

  ### Breaking — `@pwtap/mobile-inspector`
  - The driver/device selection option is now **`mobileTarget`** and the facade fixture is **`mobileApp`**
    (previously `mobile` and `app`). Both old names collided with fixtures the mobile plugins already own —
    `@pwtap/plugin-maestro` owns the `mobile` option and `@pwtap/plugin-appium` owns the `app` fixture — and
    in Playwright an option _is_ a fixture, so the collision was a merge conflict rather than an override.
    `mobileTarget` also gains `appId` and `appSource`, which are now forwarded to the driver instead of
    being dropped.

    ```diff
    - test.use({ mobile: { driver: 'appium', device: 'emulator-5554' } });
    - test('flow', async ({ app }) => { await app.tap({ accessibilityId: 'login' }); });
    + test.use({ mobileTarget: { driver: 'appium', platform: 'android', device: 'Pixel_7_API_34', appId: 'com.example.app' } });
    + test('flow', async ({ mobileApp }) => { await mobileApp.tap({ accessibilityId: 'login' }); });
    ```

  - `MobileApp.isVisible()` now resolves `false` when the element is absent instead of throwing. It is
    backed by a new `isVisible` action in the driver-neutral IR; previously it routed through
    `assertVisible`, which throws on absence, so every generated "assert not visible" failed. Generated code
    now emits `await expect.poll(() => mobileApp.isVisible(...)).toBe(...)`.
  - `MobileInspectorDriver` requires a `testBinding` (`{ extension, project, gateEnv }`). A driver now
    declares where its tests live and how they run, so adding a driver needs no changes inside the inspector.
  - The trust boundary validates an action's fields, not just its `kind`. Payloads like a `fill` with no
    `value` or a `swipe` with an invented `direction` are rejected instead of reaching an adapter.

  ### Breaking — `@pwtap/plugin-maestro`
  - The `maestro` Playwright project now matches **`*.maestro.ts`** instead of `*.mobile.ts`, so a file's
    extension names the driver that runs it for hand-written and recorded tests alike. Existing tests need a
    rename; nothing inside them changes.

    ```bash
    git ls-files 'tests/**/*.mobile.ts' | while read -r f; do
      git mv "$f" "${f%.mobile.ts}.maestro.ts"
    done
    npx create-pwtap add maestro   # re-injects the narrowed project block
    ```

  ### `@pwtap/plugin-appium`
  - Fixed an iOS text locator that could never resolve: node text is read from `label` **or** `value`, but
    the selector only matched `label`, so a locator recorded from a `value`-only element failed with
    "element wasn't found" the first time it replayed.
  - Selector values are now escaped, so UI text containing `"` or `\` no longer breaks the predicate.
  - Implements the new `isVisible` action without throwing on absence.

  ### `@pwtap/create`
  - `PluginManifest.fixture` accepts an array, letting a plugin contribute more than one fixture. Both mobile
    plugins now also contribute the shared `mobileApp` fixture, injected once and — importantly — left in
    place when only one of them is uninstalled.
  - Fixed `hasRegion`, which matched markers as substrings. Because `// pwtap:x:end` contains `// pwtap:x`, a
    file that had lost only its start marker looked intact and then crashed with an unhandled `MarkerError`
    instead of reporting the problem. This affected all four injectors.

- d434c7f: Take Electron out of the mobile stack, and split the runtime contracts away from the recorder.

  Installing a mobile plugin used to drag ~306 MB into a project that might never open the recorder: Electron
  (296 MB), a second copy of Prettier (9.6 MB) and a WebSocket library, all reachable because the plugins
  depended on the recording _application_ to get at a handful of types. That is now ≈0. Phase 1 of
  `docs/mobile-inspector/architecture.md`; the recorder itself keeps working, hosted in a browser window
  instead of an Electron shell.

  ### New — `@pwtap/mobile-core`

  The driver-neutral contracts a _test_ actually loads: the action IR and types, the locator engine, device
  discovery, the `./inspector` adapter registry, and the `mobileApp` fixture. Its only dependency is
  `@pwtap/platform`. Both mobile plugins now depend on this instead of on `@pwtap/mobile-inspector`, which the
  adapters had only ever used for types plus three pure helpers.

  ### Breaking — `@pwtap/mobile-inspector`
  - **Now a development tool, injected as a `devDependency`** by the mobile plugins' manifests rather than
    pulled in as a runtime dependency. It is not in the path of a test run.
  - **The runtime surface moved to `@pwtap/mobile-core`.** Type-only re-exports remain for one minor, so
    existing type imports get a deprecation rather than a build error; the runtime values (the `test`/`expect`
    fixture, the locator helpers) are deliberately not re-exported, because a test importing them from here
    would be loading a dev tool at runtime.
  - **Electron is gone.** `mobile-inspect` now starts a loopback service and opens it in an app-mode Chromium
    window using the browser Playwright already installed — the same way Playwright's own Inspector, UI mode
    and Trace Viewer are hosted. With no browser downloaded it prints the URL and says
    `npx playwright install chromium`. The `start` and `inspect:electron` scripts and the duplicate
    `bin/inspect-electron.mjs` launcher are removed.
  - **The transport is SSE + POST instead of WebSocket**, so `ws` is gone too: events stream from
    `GET /events`, commands go to `POST /command` with a monotonic sequence number, and frame _bytes_ are
    fetched from `GET /frame/<id>` rather than base64-encoded into an event. Reload safety comes with it —
    `EventSource` reconnects on its own, and the recording session now belongs to the service launch rather
    than to the connection, so pressing F5 mid-recording keeps the device session, the timeline and the draft.
  - **Prettier is resolved from the project** instead of bundled, so a saved test is formatted by the user's
    own version and `.prettierrc`. A project without Prettier gets an unformatted file and a log line.
  - **One inspector per project.** A second launch is refused with the URL of the first; a lock left behind by
    a crash is reclaimed rather than treated as a conflict.

  ### Fixed
  - A recorded interaction is no longer discarded because its frame id moved on. The frame id is advisory: the
    hierarchy is re-read at action time anyway, so a tap acts on the current screen instead of being dropped
    with only a warning — which is what made clicks "randomly do nothing" while the frame poll was running.
  - Disconnecting a device no longer clears the editor. The draft and timeline describe work the user did and
    survive both a disconnect and the disconnect that `run` performs before it spawns Playwright.
  - The UI's log and run-output buffers are bounded, so a long session (or a device failing on every poll) can
    no longer grow without limit.

  ### `@pwtap/create`

  Both mobile plugin manifests now contribute the shared `mobileApp` fixture from `@pwtap/mobile-core` and
  inject `@pwtap/mobile-inspector` as a devDependency.

### Minor Changes

- a5d8b7a: Replace the fixed frame poll with an adaptive capture schedule, and finish splitting the engine.

  The recorder captured every 1500 ms regardless of anything. On a slow driver that meant overlapping requests
  that saturated the device; on a fast one the screen felt stale; and a driver that cannot produce frames
  cheaply was polled anyway. Capture now happens on connect, after every action, and — only while idle, and
  only when the driver declares `liveFrames` — on an interval of twice the median measured capture time,
  clamped to 750 ms…5 s, doubling per consecutive failure up to 30 s (ADR-006).

  After an action the screen gets a 250 ms settle and, if it moved, a second look a beat later, so an
  animating transition is not recorded as the frame from halfway through it.

  `DeviceSession` now owns the device, the lock and the schedule, which completes the split of the engine into
  the five owners §6 describes; the coordinator is down from 967 lines to 562.

  **Also:** the poll timer is `unref`'d, so a session left connected by a crash can no longer keep the host
  process alive forever.

- 072cc6e: Edit test files through the project's TypeScript compiler instead of by string search (ADR-005).

  Recording into a file found its insertion point with `lastIndexOf('\n});\n')`, which lands in the wrong place
  as soon as the file has a helper, a trailing object literal or a second test — the statement then went
  outside the test body and the generated file did not compile. Appending to an existing file dropped every
  import the target did not already have unless it lacked `@fixtures` entirely.

  Both now parse with the project's own `typescript` (resolved from the project, not bundled — ADR-014): the
  statement goes at the end of the last `test(...)` block, and a merge unions imports by module specifier and
  wraps the appended body in its own `test.describe` so the generated `test.use()` cannot rewrite the target
  file's configuration. Nothing is re-emitted from the AST — the original text is sliced at the positions the
  parser reports, so formatting and comments survive. A project without `typescript` degrades audibly instead
  of silently mangling the file.

- efca711: Split the recording engine into focused modules, and fix undo/redo quietly losing work.

  The engine had grown to 967 lines owning the device, the action log, the source draft, file writing and the
  Playwright child process at once. Four responsibilities now have their own modules — `TestRunner`,
  `TestWriter`, `Recorder`, `Draft` — leaving the coordinator at 656 lines. Behaviour is unchanged except where
  noted; the existing end-to-end tests through the engine are what made the extraction safe.

  **Undo/redo no longer discards work.** The action log was a pair of stacks, and any non-append edit threw the
  redo stack away: undoing a step and then removing an unrelated one made the undone work unrecoverable with no
  indication. It is now a cursor over an append-only log, so undo destroys nothing, and a removal that does
  rewrite the log is deliberate and observable.

  **The draft's writer is explicit.** It is either generated from the action log or owned by the user once they
  type, and a device event is never the writer — which is the rule that keeps pressing Run from emptying the
  editor, since `run` releases the device before it spawns Playwright.

- d2dff69: Three recording fixes, each verified against a real emulator.

  **Tree selection survives a hierarchy read.** Every read builds a fresh object graph, and the accessibility
  tree compared nodes with `===`, so a selected element silently deselected itself on the next poll while the
  device panel kept highlighting stale bounds. Nodes now carry `path` and `key` (`assignNodeIdentity`), and the
  UI remembers the key and re-resolves it each render.

  **Maestro honours a recorded scroll direction.** The adapter called Maestro's bare `scroll()`, which only
  ever scrolls down, so the direction the user recorded was discarded; it now issues a directional swipe.
  `scroll` with `within` is refused with a clear message rather than silently scrolling the whole screen and
  producing a test that merely looks like it scrolls a container.

  **A locator from another app is flagged, not ranked highly.** A whole-screen hierarchy includes other apps'
  elements, and tapping one can succeed while the replay fails, because a driver is scoped to an app id. Such
  a node now loses 60 points and carries an explicit warning. Detection is partial by platform: Appium Android
  reports the owning package per node, while Maestro's payload has no package field at all — see §7 of
  `docs/mobile-inspector/architecture.md`.

  **Also:** the Maestro adapter was dropping `cls`, `enabled` and `val` from every node, which left the whole
  hierarchy unlabelled in the tree (91 nodes on a real screen, 0 with a class name) and weakened the new
  identity key. `val` now folds into `text`, matching how the Appium adapter already folds iOS `value`.

- 072cc6e: Make the save dialog browse the project, gate refused actions, and fix the UI's accessibility holes.

  The save dialog asked for a location as free text, so a typo became "cannot read tests" at save time. It now
  lists the project's real directories (`listDirs`), skipping `node_modules`, build output and dotfiles, with
  drill-in and a parent link. Both save and browse resolve through one confinement helper that compares path
  segments and follows symlinks — the previous `startsWith` check let `/proj-evil` pass as inside `/proj`, and
  a symlinked directory read or wrote outside the project (ADR-010).

  The locator menu no longer offers actions the connected driver refuses: each button is disabled with the
  driver's own reason as its tooltip. Only an explicit `false` in the driver's capabilities refuses, so a
  driver that has not listed a kind is not crippled.

  **Accessibility:** the connection drawer was `aria-hidden` while closed, which hid it from screen readers but
  left every control tabbable; it is now `inert`, closes on Escape, and moves focus in on open. The locator
  menu is a labelled dialog whose candidates are a radiogroup with arrow/Home/End navigation, a roving tab
  stop, focus moved in on open and restored on close. The save dialog is a native `<dialog>` opened with
  `showModal()`, which supplies the focus trap, Escape and focus restoration it previously lacked.

- 42562d6: Replace the platform compatibility shim with a declared core↔adapter contract, and validate `appSource`.

  `platformCompat.ts` imported `@pwtap/platform` as a namespace and probed each function at load time, so an
  outdated install failed with an upgrade message instead of a module-resolution crash. That treated a
  versioning problem as a runtime problem for the wrong pair of packages: `@pwtap/platform` is a direct
  dependency with a caret range, so npm already resolves a version that has the exports. The shim is deleted.

  The pair that genuinely can disagree is core and adapter, because an adapter is resolved from the client
  project's own `node_modules`. `@pwtap/mobile-core` now exports `MOBILE_CORE_CONTRACT` and
  `MIN_ADAPTER_CONTRACT`, each adapter declares the contract it was built against as a literal
  (`export const contract: AdapterContract = 1`), and discovery skips an adapter it cannot accept while
  reporting which package to upgrade — the inspector logs it, and `DriverNotFoundError` carries it so "no
  driver found" is never the whole story when the adapter is installed but unloadable. One bad adapter does
  not disable the others. The `AdapterContract` type is the exact current value, so bumping the contract
  breaks each adapter's build until someone confirms it still satisfies the new one.

  **`appSource` (ADR-010):** the artifact path comes from a browser field and ends at `adb install` /
  `simctl install` / Appium's `app` capability, so it is now validated before an adapter sees it — an existing
  local `.apk`/`.ipa`/`.zip` file or `.app` bundle directory, or an `https:` URL. Other schemes are refused,
  including `http:`. The adapter receives an absolute path so it never has to guess the base directory, while
  the generated test keeps the path as typed: an absolute one would only work on the machine that recorded it.

### Patch Changes

- 42562d6: Add the missing READMEs, and enforce the dependency budget in CI.

  Neither `@pwtap/mobile-core` nor `@pwtap/mobile-inspector` had a README — the two newest packages in the
  workspace were the two with no published documentation.

  `npm run nfr` now checks the §11 budget rows that are deterministic: no `electron` anywhere in the runtime
  packages' transitive graph, no `ws`/`prettier`/`typescript` as our own direct dependency (a third-party
  client bringing its own WebSocket implementation is its business), the inspector's published artifacts all
  present, and its unpacked size within 5 MB. CI also builds the inspector's UI bundle now, which nothing did
  before — a vite failure would have surfaced at publish time.

  A device-gated workflow (`device.yml`, nightly plus manual dispatch) runs the record → generate → save flow
  across Android × {Maestro, Appium} and iOS × {Maestro, Appium}, with a 10-minute per-test timeout because
  the 30 s default is sized for the fake driver.

- 4235259: Fix three defects found by packaging the product and installing it into a clean project.

  **Stale build output shipped.** `tsc -b` emits but never prunes, so a moved or deleted source leaves its
  `.js`/`.d.ts`/`.map` in `dist` forever. `@pwtap/mobile-inspector` was publishing eleven orphans, including
  the three `dist/electron/*` modules ADR-001 removed — dead code importing a package that is not a
  dependency — and `@pwtap/mobile-core` shipped the deleted `platformCompat`. Every publishable package now
  cleans its output before building (`npm run clean`), and `npm run nfr` fails on any `dist` file with no
  matching source.

  **Ctrl-C during launch crashed the CLI.** Launching the browser takes a second or two. A signal in that
  window left `newPage()`/`goto()` to reject unhandled: the CLI died with a stack trace and exit 1 before
  `service.close()` could release the device lock or delete its temp files — precisely the teardown ADR-011
  requires — and a signal arriving even earlier killed the process outright, since the handlers were not yet
  installed. The handlers now go in before the service starts, the window launcher hands back a closable
  handle the moment the browser exists (so a signal mid-launch cannot orphan a Chromium), and a navigation
  failure is reported rather than thrown.

  **`remove` left a project that would not compile.** Removing a plugin unwires its fixture, Playwright
  project, env keys and package, but deliberately leaves the example tests it installed — a user may have
  built their suite on them. Silence was the wrong middle ground: `tsc` and `playwright test` both failed on
  imports of a package that was gone, with nothing explaining it. The files still stay; `remove` now names
  them and says why.

  Verified by installing every package from a local tarball into a freshly scaffolded project — no workspace
  links, no registry: both mobile plugins wire in with the shared `mobileApp` fixture injected exactly once,
  generated `*.maestro.ts`/`*.appium.ts` tests type-check and are collected by their own gated project and no
  other, and `mobile-inspect` serves the UI, refuses an untokenised request and exits 0 on a signal.

- Updated dependencies [d2dff69]
- Updated dependencies [42562d6]
- Updated dependencies [42562d6]
- Updated dependencies [4235259]
  - @pwtap/mobile-core@1.1.0

## 1.0.0

### Major Changes

- 5f96d85: mobile inspector issue fix

### Patch Changes

- Updated dependencies [5f96d85]
  - @pwtap/platform@1.0.0

## 0.1.2

### Patch Changes

- 76bd9d8: Harden mobile-inspector/runtime compatibility and raise the Node baseline.

  - `@pwtap/mobile-inspector` now loads platform APIs through a compatibility bridge so outdated
    `@pwtap/platform` installs fail with a clear upgrade error instead of crashing module load on
    missing named exports.
  - Tighten plugin runtime dependency ranges to mobile-inspector/platform versions that include the
    inspector integration fixes.
  - Raise supported Node version to `>=22.23` across the monorepo's publishable packages.

- Updated dependencies [76bd9d8]
  - @pwtap/platform@0.3.2
