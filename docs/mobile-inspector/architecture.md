# Mobile Inspector — Architecture & Decision Record

**Status:** accepted (spec) · **Supersedes:** `docs/mobile_inspector_design.prompt.md` (kept as the original
product brief) · **Owns:** `@pwtap/mobile-core`, `@pwtap/mobile-inspector`, the `./inspector` adapters in
`@pwtap/plugin-maestro` / `@pwtap/plugin-appium`.

This document is normative and describes the **target** state, not today's code. Where it says
MUST/MUST NOT, code that disagrees is a bug — including code that exists right now. Where it says SHOULD,
deviation needs a note in the PR. §12 tracks how far the implementation has come.

---

## 1. Why this document exists

The only prior design artifact was a **prompt** (`mobile_inspector_design.prompt.md`), not a
specification. It asked good questions and left the expensive ones open. The shipped implementation then
answered them implicitly, and every open question turned into a defect. The traceability is close to
one-to-one:

| Gap in the brief                                          | Defect it produced                                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Generated test's runtime contract never defined           | Generated tests cannot run: `app` resolves to plugin-appium's raw WebdriverIO session; `mobile` option collides with plugin-maestro's own option |
| Recording specified as a gesture list, not a state model  | Frame-staleness gating silently drops taps that race the poll timer                                                                              |
| "Should codegen use AST transforms?" left open            | String templates + regex file surgery; `mergeIntoExistingTest` drops imports, two `aiAssert`s emit a duplicate identifier                        |
| No non-functional targets                                 | 296 MB Electron in every client install, screenshot files never deleted, unbounded log/run arrays                                                |
| No test/verification strategy                             | Zero tests in a package whose riskiest code is pure and trivially testable                                                                       |
| No phase exit criteria                                    | "record → save → run is green on a device" was never a gate, and today it is not green                                                           |
| "Assume Playwright exposes extension points"              | Shipped as the standalone Electron app the brief explicitly rejected                                                                             |
| Driver capability asymmetry not a first-class deliverable | `isVisible()` can never return `false`; unsupported gestures not surfaced                                                                        |
| No security/trust-boundary section                        | Trust boundary validates only an action's `kind`, not its payload                                                                                |
| No core↔adapter compatibility contract                    | `platformCompat.ts` runtime shim papering over missing exports                                                                                   |

So: this document fixes the contracts first. §4 is the decision record, §5–§10 the normative specs, §11
the non-functional budget, §12 the phased plan with exit criteria, §13 the release and migration sequence
for packages that are already published.

---

## 2. Scope

### In scope

Recording a driver-neutral mobile flow against a booted Android emulator or iOS simulator, ranking
locators for the elements touched, generating a readable Playwright test that uses the platform's own
fixture barrel, saving it into the project, and running it back.

**Supported hosts.** macOS drives both platforms. **Linux drives Android**, and does so because CI forced the
question: GitHub's macOS runners are Apple silicon and expose no hypervisor, so the emulator could not start
there at all (`HVF error: HV_UNSUPPORTED`), while a Linux runner has KVM. `@pwtap/platform` now has a
`LinuxPlatform` alongside `MacPlatform`; it answers iOS calls with a failed `RunResult` rather than a throw,
which is what device discovery and the pickers already handle, so an iOS request on Linux degrades to "no
simulators" instead of crashing a UI that was only asking. iOS stays macOS-only by platform constraint, not by
our choice. Windows is **best-effort**: the code MUST stay path-portable (it already branches on
`playwright.cmd`) and MUST NOT hard-code POSIX separators, but no phase exit criterion depends on Windows and
no CI job covers it — `getPlatform()` throws there, naming the file to add.

### Explicitly out of scope (with reason)

| Deferred                                                       | Why, and what would unlock it                                                                                                                       |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real physical devices                                          | Device discovery is emulator/simulator-shaped (`listAvds`, `listIosSimulators`). Needs a device-source abstraction in `@pwtap/platform` first.      |
| Multiple simultaneous devices                                  | One `DriverSession` per recording session by design (device locks assume it). Multi-device recording is a v2 product question, not a wiring change. |
| WebView / hybrid contexts                                      | Requires context switching in both adapters and a context concept in the node model.                                                                |
| OS-level UI (permission dialogs, notification shade)           | Lives outside the app's accessibility tree; needs a separate capture path.                                                                          |
| IME / soft-keyboard text entry beyond `fill`                   | Adapter-specific and flaky; `fill` covers the recorded case.                                                                                        |
| Orientation / locale changes mid-recording                     | The frame model handles orientation changes on capture, but recording a _rotation action_ is not modeled.                                           |
| Page Object extraction, AI locator repair, flow simplification | Depends on a stable action IR + codegen, i.e. on this document landing first.                                                                       |

Anything in this table that shows up in a PR needs a spec amendment, not an inline improvisation.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  UI (React, ui/)                        served over loopback HTTP   │
│  device viewport · a11y tree · locator menu · editor · timeline     │
└───────────────────────────┬─────────────────────────────────────────┘
                            │  transport-neutral JSON protocol (§10)
┌───────────────────────────┴─────────────────────────────────────────┐
│  @pwtap/mobile-inspector   (devDependency — never in a test's path) │
│  ┌──────────┐ ┌──────────┐ ┌────────┐ ┌───────────┐ ┌────────────┐ │
│  │ Device   │ │ Recorder │ │ Draft  │ │TestWriter │ │ TestRunner │ │
│  │ Session  │ │ (IR)     │ │(source)│ │(AST save) │ │(pw spawn)  │ │
│  └──────────┘ └──────────┘ └────────┘ └───────────┘ └────────────┘ │
│  service/ (http + ws, loopback, token)   ·  cli/ (window launcher)  │
└───────────────────────────┬─────────────────────────────────────────┘
                            │  MobileInspectorDriver / DriverSession
┌───────────────────────────┴─────────────────────────────────────────┐
│  @pwtap/mobile-core        (runtime dependency of the plugins)      │
│  types (action IR) · locator engine · imageSize · deviceDiscovery   │
│  registry (./inspector discovery) · the MobileApp test fixture      │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
        ┌───────────────────┴───────────────────┐
│  plugin-maestro/inspector  │  plugin-appium/inspector  │  future     │
└─────────────────────────────────────────────────────────────────────┘
```

The load-bearing property: **the runtime path of a generated test touches only `@pwtap/mobile-core` and
one adapter.** The inspector application — service, UI, codegen, browser launcher — is a development
tool and never enters a client project's production dependency graph.

---

## 4. Decision record

### ADR-001 — Host: loopback service + a Playwright-managed Chromium window. Electron is removed.

Playwright's own Inspector, UI mode, and Trace Viewer are all browser-hosted local web apps; none use
Electron. Playwright's `launchApp` opens its recorder as a persistent-context Chromium window with
`--app=data:text/html,`, `--window-size`, `--window-position`, `--test-type=`, and
`ignoreDefaultArgs: ['--enable-automation']`, then navigates that page. That is reproducible with the
public `chromium.launchPersistentContext` API, and `@playwright/test` — already a peer dependency —
brings the browser with it.

- The inspector MUST serve its UI from a loopback HTTP server and open it with a Playwright-managed
  Chromium app window (falling back to the user's default browser with a printed URL). The wire between
  them is specified in ADR-013.
- `electron` MUST NOT be a dependency of any published package.
- Consequences: native file dialogs are gone. Replaced by in-app pickers backed by protocol messages
  (§10) — the project-relative directory/file browsing the UI already partly has. Clipboard uses
  `navigator.clipboard`, which is available because `http://127.0.0.1` is a secure context.
- Cost: we own window lifecycle instead of Electron's. Benefit: −296 MB from every client install, the
  brief's "not a standalone application" constraint satisfied, and the same UI trivially rehostable in a
  VS Code webview later.

### ADR-002 — No forking or patching Playwright. Public APIs only.

The brief's "assume Playwright exposes extension points (or propose them)" is rejected as an engineering
premise: Playwright exposes no extension point for the Inspector/recorder UI. Integration deeper than
ADR-001 would require patching `playwright-core` internals, which we will not ship. `playwright codegen
--mobile` is therefore an upstream RFC ambition, recorded here and not on any phase plan.

### ADR-003 — The generated test's runtime contract (normative)

This is the contract the whole product hangs on. A generated file MUST look exactly like this:

```ts
import { test, expect } from '@fixtures';

test.use({
  mobileTarget: {
    driver: 'appium',
    platform: 'android',
    device: 'Pixel_7_API_34',
    appId: 'com.example.app',
  },
});

test('recorded flow', async ({ mobileApp }) => {
  await mobileApp.tap({ accessibilityId: 'loginButton' });
  await mobileApp.fill({ accessibilityId: 'username' }, 'demo@test.com');
  await expect.poll(() => mobileApp.isVisible({ text: 'Dashboard' })).toBe(true);
});
```

Decisions encoded above, each one closing a current defect:

1. **Names.** The selection option is `mobileTarget`; the facade fixture is `mobileApp`. `app`, `mobile`,
   `device`, and `appium` are all already taken by the two plugins, and in Playwright an option _is_ a
   fixture, so reusing any of them is a merge conflict. These two names are new and collide with nothing.
2. **`platform` and `appId` MUST be emitted.** The recorder knows both (`session.device.platform`, the
   connect options); omitting them is why generated tests throw "platform not set" and why Maestro
   replay attaches to no app. `MobileTarget` gains `appId` and `appSource`, and the fixture MUST forward
   them to `driver.connect()`.
3. **Wiring.** The `mobileApp` fixture is contributed to the `@fixtures` barrel **once**, by
   `@pwtap/mobile-core`, regardless of how many mobile plugins are installed. Both plugin manifests
   declare the same fixture fragment with a shared dedupe key; `@pwtap/create`'s injector MUST skip a
   duplicate. The existing `maestro` and `app` fixtures are untouched.
4. **App identity.** A driver that cannot act without an app id MUST NOT hand back a session that has none.
   Maestro scopes every command — including `tap` and `back` — to one app and refuses until it is set, so a
   connection with an empty app id used to produce a session that showed the screen and failed every
   interaction with an internal message. Such a driver MUST resolve an app itself (the foreground app is what
   the user is looking at, so it is the one they mean). Whatever it resolves MUST be reported back on the
   session (`DriverSession.appId`) and is what codegen pins: a test that pinned nothing would launch nothing on
   replay and re-record against whatever happened to be open.

   **Refusing when it cannot resolve one was wrong for a recorder**, and it made the Maestro driver unusable on
   iOS: nothing there reports the frontmost app — `launchctl list` names every running one, `simctl appinfo`
   names none, and the view hierarchy's app label is not dependably present — so `connect failed: … no app id
was given or could be detected` was the only possible outcome of an iOS connect without one. Android was
   little better: connecting while the device sat on the home screen detected the _launcher_, which Maestro
   cannot launch, and failed the same way.

   So the two callers are separated by `ConnectOptions.attachWithoutApp`, which only the recorder sets:
   - **Recording** attaches to whatever is on screen instead of refusing. Maestro's own `appId: any` header
     satisfies the config section without scoping the flow — verified on a simulator for `tapOn` by point and
     by selector, `assertVisible`, `extendedWaitUntil`, `swipe`, `waitForAnimationToEnd` and `back`. A _detected_
     app id that fails to launch degrades the same way, because it was a guess; an app id the caller **named**
     still throws, because getting that wrong is worth hearing about.
   - **Replay** keeps the refusal, with a message naming what to set. A test that never launches its app and
     taps whatever is in front of it passes or fails for reasons that have nothing to do with the test.
   - A session with no app pinned MUST say so where the user is recording (§9's `connected.warnings`), because
     the recording is real and the generated test still needs an `appId` before it can run. Codegen MUST NOT
     emit `any`: it is a flow-header wildcard, not a bundle id anything can launch.

5. **Device identity.** The emitted `device` MUST be replayable days later, so it MUST NOT be an
   ephemeral handle. Android: the AVD name, never the `adb` serial — device discovery reports booted
   emulators _by serial_ (`emulator-5554`), which changes across reboots, so the recorder MUST map the
   connected device back to its AVD name before codegen. **Two rules make that mapping reliable, and both
   were broken in the field:** `DiscoveredDevice.name` MUST be the device's own AVD name — never the
   caller's input echoed back, never the serial — and the resolver MUST look the connected `id` up in the
   device list it is handed, which is the authority for the serial→AVD mapping. Getting either wrong
   produced a recording pinned to `emulator-5554`, which fails with "no android device available" the
   moment that emulator instance is gone. iOS: the simulator name when it is unambiguous
   among installed simulators, otherwise the UDID (names are not unique — two "iPhone 15" runtimes are
   legal; UDIDs are stable across reboots). The resolver lives in `@pwtap/mobile-core` next to
   `deviceDiscovery`, so the fixture and the recorder cannot disagree about what a `device` string means.
   The fallback is safe because `@pwtap/platform` resolves a device by _either_ handle on both code paths —
   `findBootedIos` matches `udid === deviceName || name === deviceName`, and the boot path goes through
   `resolveSimUdid`, which does the same. When neither handle is durable (an Android emulator whose AVD
   name could not be resolved, leaving only an `adb` serial) the recorder MUST warn rather than quietly
   pin a value that stops matching after a reboot.
6. **Assertions.** Visibility assertions are generated as `expect.poll(() => mobileApp.isVisible(...))`,
   which requires `isVisible` to _return a boolean_ — see ADR-004 and §5.

### ADR-004 — `isVisible` becomes its own boolean action

Today `MobileApp.isVisible()` maps to the `assertVisible` action, and both adapters throw when the
element is absent, so the facade throws instead of returning `false` and every generated
"assert not visible" fails. Therefore:

- The action IR gains `{ kind: 'isVisible'; locator; options? }` whose `ActionResult.value` is a boolean
  and whose `ok` is `true` for both outcomes. Only a driver/transport error yields `ok: false`.
- `assertVisible` / `assertNotVisible` remain as _recording-time_ actions (they execute and must hold),
  but codegen emits `expect.poll(() => mobileApp.isVisible(...))` so the generated test carries its own
  waiting semantics instead of depending on adapter timeout behaviour.
- Adapters MUST implement `isVisible` without throwing on absence: Appium via `isExisting() &&
isDisplayed()` under a bounded poll, Maestro via its visibility query with `timeout` and a `false`
  return rather than an assertion.

### ADR-005 — Codegen is AST-based; string surgery is removed

`generateTestSource` may keep templating a _new_ file (it is a fixed shape), but every operation on an
**existing** file — appending a recorded test, inserting a statement into a hand-edited draft, merging
imports — MUST go through a real TypeScript AST. **No AST library is added:** every scaffolded project
already declares `typescript` (`core-template/manifest.json`), so the inspector resolves the _project's_
compiler API through `createRequire(projectRoot)` per ADR-014, and degrades to append-at-end with an
explicit message if it is missing. `insertStatementIntoTest` and `mergeIntoExistingTest` are deleted.

Save semantics stay explicit and non-destructive: `new` refuses to overwrite; `append` requires the file
to exist, merges the recorded test as its own `test.describe`, preserves every existing import, and adds
the `@fixtures` import only if absent.

### ADR-006 — Frame and interaction model: freshness is verified, never used to reject

The current model gates every interaction on `frameId === lastFrameId` while a 1.5 s timer keeps bumping
`frameId`, so the poll silently invalidates the user's click. Replaced by:

- **No interaction is ever rejected because of frame identity.** At action time the server re-reads the
  hierarchy, hit-tests, performs, and reports what it matched (`actionResult.matchedBy`), so a stale
  click becomes visible feedback instead of a dropped event.
- `frameId` is retained for diagnostics and frame dedup only.
- **Capture schedule:** on connect; after every action; on explicit refresh. Idle polling happens only
  when the driver declares `liveFrames` and the session is idle, at an adaptive interval of
  `clamp(2 × p50(captureDuration), 750 ms, 5 s)`, with ×2 exponential backoff up to 30 s on consecutive
  failures, reset on success. An idle tick captures the **frame only**; the hierarchy is read only when the
  frame's bytes changed, because a tree cannot have moved while the pixels did not — and on Maestro that
  second round trip is ~110 ms of the device's attention per tick that the user's next interaction has to
  queue behind.
- **Post-action settle:** one capture immediately (the action has already happened, so whatever moved is on
  screen now), then it depends on the driver. A driver that reports `ActionResult.settled` waited for the
  animation itself — Maestro sends `waitForAnimationToEnd` inside the same command, which costs nothing
  because its overhead is per _call_, not per line — so one hierarchy read finishes the job. A driver that
  does not gets a `250 ms` sleep and a second capture, and a third only if those two settled captures still
  differ. Comparing against the _pre-settle_ frame instead made the third look unconditional: a tap always
  looks different a beat later. The hierarchy is read **once, last**; reading it mid-animation and again at
  the end bought a tree that was stale before it arrived and paid for it twice.
- **Dedup:** identical frames MUST NOT be re-sent; the server sends `frameUnchanged { frameId }` instead
  of a second multi-megabyte payload. The same holds for the hierarchy: an unchanged tree is not re-sent at
  all, because the client rebuilds its whole accessibility view from one, which on a deep native tree is
  continuous main-thread work while the device sits idle.
- **Captures never round-trip through the filesystem.** Both adapters wrote each frame into a temp directory
  and read it straight back to produce the base64 the contract already had in hand — and neither emptied the
  directory, so a ten-minute session at one frame per 750 ms left hundreds of screenshots on disk against a
  §11 budget of three. `screenshot`/`aiAssert` and failure evidence still write files, because a file is
  what those are for.
- **Transport:** frame _bytes_ never travel inside a JSON message. The `frame` event carries only
  metadata (id, dimensions, coordinate space, orientation) and the image is fetched from
  `GET /frame/<frameId>` by an `<img src>` (ADR-013) — no base64, which would inflate every payload by a
  third and force a multi-megabyte JSON parse on the UI thread. `coordinateWidth`/`coordinateHeight`
  already decouple the interaction coordinate space from the encoded image size, so the server MAY
  down-scale or re-encode to stay under the §11 payload budget.
- **Hover highlight is client-side** against the last hierarchy (target: no round trip, see §11), and the
  hit-test MUST be throttled to at most one evaluation per animation frame.

#### ADR-006 addendum — the recording MUST NOT wait for the device

Reported from a live installation as 2–3 s of lag on every interaction, and the measurement above says why:
the action was performed first and recorded only once the driver confirmed, so the generated code arrived a
full Maestro tap-latency behind the click.

- Hit-testing is local, so a click becomes an action with no device round trip. The action MUST enter the
  timeline and the code **immediately**, before the driver is asked to perform it.
- A driver that then refuses it MUST cause the action to be **retracted** — by identity, not by position,
  because the user can undo or delete something while the device is still answering — and the refusal MUST be
  surfaced on screen (§9), not only in the log.
- The hierarchy MUST NOT be re-read before hit-testing when the client's `frameId` is the device's current
  frame: the tree already in hand IS the screen the user clicked. Re-reading it unconditionally cost a device
  round trip per interaction for nothing.
- **A device click MUST be driven by coordinate, while the element is what gets recorded.** The hit-test has
  already identified the element locally; asking the driver to find it again is a second lookup that costs
  ~800 ms per tap on Maestro. A driver that cannot tap a raw point MUST fail loudly (the action is retracted
  and reported) rather than be given a silent locator retry, which would hide the gap and double the latency
  of every failure. A locator chosen from the right-click menu is the exception — there the user is choosing a
  locator, so that is what gets performed.
- **The lost guarantee MUST be bought back by sampling, not by paying per tap.** Driving by coordinate stops
  proving that the recorded locator resolves on this driver, and that class of bug is real. So each locator
  _strategy_ in the recording is verified once per session, after the screen has settled and against the
  current tree — the bugs are systematic, so one element answers for all of them, and the check never blocks
  an interaction or fails a recording.
- After an action the device MUST be looked at immediately, then again after the settle delay. Waiting the
  full settle before the first look is what made a tap take half a second to show any visible effect.

### ADR-007 — Node identity: every hierarchy node carries a stable key

Tree selection currently compares node objects by reference, so a hierarchy refresh silently drops the
selection while the viewport keeps drawing stale bounds. Normalization MUST therefore assign each node a
deterministic `path` (its index chain from the root, e.g. `0/2/1`) and a `key` derived from
`path + className + resourceId + accessibilityId`. Selection, tree expansion state, and highlight
association are keyed on `key`, never on object identity.

### ADR-008 — Package split: `@pwtap/mobile-core` (runtime) vs `@pwtap/mobile-inspector` (dev tool)

The adapters import exactly four things from the inspector package today: the types, plus
`discoverMobileDevices`, `readImageSize`, `resolveTargetPoint`. Everything else — service, UI, codegen,
CLI, `ws`, `prettier`, `electron` — is dead weight in a client's dependency graph. Therefore:

- **`@pwtap/mobile-core`** — the action IR and types, the locator engine, `imageSize`, `deviceDiscovery`,
  `platformCompat`, the `./inspector` adapter registry, and the `mobileApp` test fixture. Runtime
  dependency of both plugins. Dependencies: `@pwtap/platform` only.
- **`@pwtap/mobile-inspector`** — recording service, UI bundle, codegen, save/run, CLI window launcher.
  Injected by the plugin manifests as a **devDependency**. Free to depend on `ws`, a formatter, and an
  AST library, because it never ships into a test run.
- The plugins depend on `@pwtap/mobile-core`, never on `@pwtap/mobile-inspector`.

### ADR-009 — Core↔adapter compatibility is a declared contract, not a runtime shim

`platformCompat.ts` exists because an older `@pwtap/platform` could be installed against newer inspector
code, crashing module load on a missing named export. That shim treats a versioning problem as a runtime
problem. Instead:

- `@pwtap/mobile-core` exports a `MOBILE_CORE_CONTRACT` integer, bumped on every breaking change to
  `MobileInspectorDriver` / `DriverSession` / the action IR, plus `MIN_ADAPTER_CONTRACT` for the oldest
  adapter it still accepts.
- Each adapter exports the contract version it was built against **as a literal** — importing the constant
  would make it agree with whatever core is installed, which is the mismatch being checked. The `AdapterContract`
  type is the exact current value, so bumping the contract breaks each adapter's build until a human reviews it.
- The registry skips an adapter it does not accept and reports which package to upgrade, through an
  `onProblem` reporter: the inspector logs it to the UI, and the fixture folds it into `DriverNotFoundError`
  so "no driver found" is never the whole story when the adapter is installed but unloadable.
- One bad adapter must not disable the others: discovery continues past it.
- The runtime shim is deleted. `@pwtap/platform` is a direct dependency with a caret range, so npm resolves
  a version that has the exports — probing each import at load time treated versioning as a runtime problem.

### ADR-010 — Trust boundary and security posture

The renderer is untrusted even though it is local; the service writes files and spawns processes.

- **Bind:** loopback only, random port, per-launch random token. Every HTTP request MUST present the token;
  `Origin` MUST be loopback. The asset cookie MUST be `HttpOnly; SameSite=Strict` and the served page MUST
  carry a strict CSP.
- **The token MUST NOT be written where a human or a file can keep it.** It is a live credential for a
  service that spawns processes and writes files, and it was previously printed on every launch (`?token=…`
  in the URL the CLI logs) and stored in the single-instance lock file under `node_modules`. Neither was
  needed:
  - The window the CLI opens authenticates with an **`x-inspector-token` header**, set on the Playwright
    browser context so it covers the navigation and every subresource. The token then never reaches printed
    output, the page's own `location`, the browser profile, or `ps` (the window still opens on a blank
    `data:` URL and navigates afterwards, so it is not in `--app=` either).
  - The lock file holds **port and pid only**. It stored the token so a second launch could quote a
    ready-to-open URL — a live credential in a world-readable file for the length of a session, to save one
    relaunch.
  - `?token=` remains for the one case with no alternative: a browser this process did not launch cannot be
    given a header. That URL is printed **only** when no window could be opened, and says what it carries.
  - Duplicate `x-inspector-token` headers MUST be refused rather than resolved: Node folds them into one
    comma-separated value, and accepting a prefix would let a caller append a guess to a real token.
- **Validation:** every inbound message MUST be validated _field by field_, not just by `kind` — see the
  per-action required-field table in §5. An action with a missing or wrongly typed field is rejected with
  an `error`, never forwarded to an adapter.
- **File writes:** confinement MUST be checked against the _realpath_ of the resolved target and by path
  segment, because two escapes get through the obvious check: a symlink out of the tree, and a sibling
  directory whose name starts with the project's (`/proj-evil` passes `startsWith('/proj')`). The
  extension MUST be one of the driver extensions in §8, and `new` mode MUST NOT overwrite. Directory
  listing for the save dialog is the same trust boundary and uses the same helper.
- **`appSource`:** accepted only as an existing local file with an allowed extension
  (`.apk/.app/.ipa/.zip`) or an `https:` URL, validated before it reaches an adapter or an installer.
- **`run`:** argv-only `spawn` (no shell), fixed argument list, explicit env, the child killed on session
  teardown, and the temp file removed on every exit path including cancellation.
- **Teardown:** **launch** teardown — the CLI exiting, the window closing, or a signal — MUST release the
  device lock, close the driver session, kill any run child, and delete the session's temp directory.
  Losing a _socket_ MUST NOT do any of that; see ADR-011.

### ADR-011 — The recording session belongs to the launch, not to the socket

This is a hole opened by ADR-001 and it has to be closed before Phase 1 ships. Under Electron there was
exactly one long-lived window, so binding a `RecorderSession` to the transport was harmless. In a browser
host, pressing **F5** closes the WebSocket — and with today's per-socket ownership that would release the
device lock, close the driver session, and destroy the recorded timeline and draft. A page reload must
not cost the user their recording.

- One `RecorderSession` per **service launch**, owned by the service, not created on WS upgrade.
- A reconnecting socket **reattaches** to the live session and is immediately re-synced: current device
  state, timeline, draft + revision, capabilities, last frame. Reattach is the normal path, not recovery.
- The service accepts at most one attached client at a time; a second client is refused with a clear
  message rather than silently racing over one device.
- **Single instance per project root.** The CLI writes a lock file (port + token + pid) under the
  project; a second `mobile-inspect` in the same project MUST detect a live service and focus/print its
  URL instead of starting a competing one. A stale lock (dead pid) is reclaimed.
- **Device-lock contention is explained, never mysterious.** If `acquireDeviceLock` cannot be taken
  (a `npm test` run or another inspector holds the device), the UI MUST say which device is busy and what
  holds it, not fail with a timeout.

### ADR-012 — Tests run on `node:test` with native TypeScript, zero new dependencies

The monorepo has no unit-test runner today, which is why "add tests" never had a landing spot. Node's
built-in runner executes `.ts` directly via type stripping (verified on this repo's Node baseline), so:

- Unit and integration tests live in `packages/<pkg>/test/**/*.test.ts`, run with `node --test` from a
  root `npm test`, and assert with `node:assert/strict`. **Not** beside their source: a package's
  `tsconfig` includes `src/**` only, so co-located tests would either be emitted into a published
  `dist/` or — if excluded — belong to no TypeScript project at all, which strips editors of their
  `node` types. A `test/` directory with its own tiny `tsconfig.json` avoids both, and the root
  `tsconfig.tests.json` type-checks them all (`npm run typecheck:tests`), because `node --test` strips
  types without ever verifying them.
- Type stripping erases types only — no `enum`, no `namespace`, no constructor parameter properties in
  any module a test loads. TypeScript's `erasableSyntaxOnly` MUST stay enabled in `tsconfig.base.json`
  so the compiler rejects that syntax at build time instead of the runner dying on
  `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. (Enabling it surfaced 15 real violations across 7 files.)
- Node does not map a `./x.js` specifier onto `x.ts`, and every source file here addresses its siblings
  with the emitted `.js` extension because `moduleResolution` is `NodeNext`. Tests therefore load source
  through one resolution hook (`scripts/test-hooks.mjs`, registered via `--import`) that rewrites
  `.js` → `.ts` **only when the importer is itself a `.ts` file**, so compiled output is never affected.
  The alternative — TypeScript's `rewriteRelativeImportExtensions` — is the blessed long-term path but
  costs a monorepo-wide rewrite of every relative import in shipped source to delete twenty lines that
  only run under `--test`.
- `@playwright/test` stays what it is: the runner for device-gated and generated tests. It is not used
  for pure unit tests, which need no browser, no config, and no fixtures.
- Golden files are plain `.txt`/`.ts` fixtures compared with `assert.equal`, updated by an explicit
  `UPDATE_GOLDEN=1` env var — never auto-blessed on failure.

### ADR-013 — Transport: Server-Sent Events + POST on `node:http`. No WebSocket library.

Node ships a WebSocket _client_ but no server, so keeping a WS protocol means keeping the `ws` dependency
forever. The protocol does not actually need WebSocket's bidirectional framing: commands are discrete
client→server requests, events are a server→client stream, and frames are images.

- **Events (server→client):** one SSE stream, `GET /events` (`text/event-stream`) — native on both sides
  (`EventSource` in the browser, plain `node:http` on the server).
- **Commands (client→server):** `POST /command` carrying the JSON `ClientMessage`, answered `202 Accepted`.
  Results come back as events, so everything the UI renders shares one causal order.
- **Frames (server→client):** `GET /frame/<frameId>` returning the raw PNG/JPEG **bytes** for an
  `<img src>`. Frames leave the JSON path entirely — no base64, no megabyte JSON parse on the UI thread,
  and the browser decodes off-thread.
- **Reload safety comes free:** `EventSource` reconnects by itself and resumes from `Last-Event-ID`, which
  is precisely the reattach handshake ADR-011 requires. Server events MUST therefore carry monotonic ids.
- **Ordering is the one thing this costs us:** independent POSTs can race, which WS framing hid. The UI
  MUST keep at most one command in flight and every command MUST carry a monotonic client `seq` that the
  server rejects when it arrives out of order — a reordered or dropped `tapAt` must surface as a visible
  error (§6), never as a silent no-op.
- **`seq` is scoped to the ATTACHED CLIENT, and MUST be reset on attach.** A browser counts from 1 on every
  page load, so a launch-wide counter refused every command from a reloaded page while frames kept arriving:
  the page looked alive and recorded nothing. Ordering only ever needed to hold within one client's own
  stream of POSTs.
- **A new client TAKES OVER rather than being refused.** Two clients must never share one device and one
  draft, but refusing the newcomer was the wrong end to cut: the CLI opens a window and prints the URL, and
  an `EventSource` that receives a non-200 never retries, so opening that URL produced a permanently deaf
  page. The displaced client MUST be told (`displaced`) and MUST close its own stream, or a server-side close
  reads as a retryable drop and the two views displace each other forever.
- `ws` MUST NOT be a dependency of any published package.

### ADR-014 — Dependency policy: use the host project's toolchain, never ship a second copy

This is a test-automation _substrate_ with a plugin architecture, so every megabyte it adds is paid by
every project that installs it. Two standing rules:

1. **Prefer the project's own toolchain.** The inspector runs inside a scaffolded project that already
   declares `typescript`, `prettier`, `eslint`, and `@playwright/test` (`core-template/manifest.json`).
   Resolve those from `projectRoot` via `createRequire`, and degrade with a clear message when one is
   absent. A bundled second copy is both heavier _and_ less correct — the project's own version and
   config are the ones the user expects to apply.
2. **The dependency type states the intent.** Runtime `dependencies` only for what a _test_ executes;
   `peerDependencies` for what the host project already owns; manifest-injected `devDependencies` for
   development-only tooling. A dev tool sitting in `dependencies` is a bug.

Applied, measured against the installed tree rather than estimated:

| Decision                                                         | Effect                                            |
| ---------------------------------------------------------------- | ------------------------------------------------- |
| `@pwtap/mobile-core` runtime / inspector devDependency (ADR-008) | the split that makes everything below reachable   |
| `electron` removed, Playwright's Chromium reused (ADR-001)       | **−296 MB**                                       |
| `ws` removed, SSE + POST on `node:http` (ADR-013)                | −196 KB, and base64 framing gone                  |
| `prettier` resolved from the project                             | −9.6 MB duplicate of what the project already has |
| AST through the project's `typescript` (ADR-005)                 | no `ts-morph`; the AST question is closed         |

Net: a client that installs a mobile plugin and never opens the inspector goes from **≈306 MB of
avoidable transitive weight to ≈0**.

Deliberately unchanged, and why: `webdriverio` (5.5 MB plus transitives) and `fast-xml-parser` (1.3 MB) in
`plugin-appium`. A minimal W3C WebDriver client over Node's built-in `fetch` is feasible in a few hundred
lines, but `webdriverio` _is_ that plugin's advertised public surface — its `app` fixture is a raw
WebdriverIO session. Removing it would be a product decision, not a dependency cleanup, and belongs to the
separate Appium/Maestro review.

---

## 5. Action IR and driver capability matrix (normative)

**Two rules the adapters broke, found by auditing them (§12 Phase 4):**

- **Defaults belong to the contract, not the adapter.** Every option here is optional, and each adapter used
  to invent its own value for the ones a test omitted: `isVisible` waited 2 s on Maestro and 5 s on Appium,
  `longPress` held 1 s on Appium and whatever Maestro chose. So the same test body — the entire promise of a
  driver-neutral IR — behaved differently by driver, silently and only under timing. An adapter MUST resolve an
  omitted option from `ACTION_DEFAULTS` in `@pwtap/mobile-core`.
- **An option a driver cannot express MUST be refused, never ignored.** `SwipeOptions.distance` was read by
  neither adapter, so `swipe('up', { distance: 0.3 })` was a public API that did nothing; Maestro discarded
  `longPress`'s `durationMs`, which its own `longPressOn` cannot vary. Silently substituting the driver's
  behaviour generates a test that reads as one thing and is another. Refusal is the pattern `scroll` already
  used for `within`.
- **Capabilities vary by platform, so the SESSION is the authority.** `MobileInspectorDriver.capabilities` is
  one static answer given before a platform is known, so a driver whose support differs had to overstate it:
  Appium declared `back: true` and threw `"back" has no iOS equivalent` on iOS, leaving the UI offering a
  button that always failed and the fixture's support check passing. A session MAY narrow it
  (`DriverSession.capabilities`), and every consumer MUST prefer the session's answer when present.

Required fields per action — the validation table the trust boundary implements:

| Action                                                                                       | Required                           | Optional                                                                    |
| -------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------- |
| `tap`, `doubleTap`, `longPress`, `waitFor`, `assertVisible`, `assertNotVisible`, `isVisible` | `locator` (≥1 strategy set)        | `options.durationMs` / `options.timeoutMs`                                  |
| `fill`                                                                                       | `locator`, `value: string`         | —                                                                           |
| `eraseText`                                                                                  | `locator`                          | `options.characters` (positive integer; omit to clear the field)            |
| `hideKeyboard`                                                                               | —                                  | —                                                                           |
| `scrollUntilVisible`                                                                         | `locator`                          | `options.direction`, `options.timeoutMs`                                    |
| `swipe`, `scroll`                                                                            | `direction ∈ {up,down,left,right}` | `options.distance ∈ [0,1]`, `options.durationMs`, `options.within` (scroll) |
| `drag`                                                                                       | `from`, `to` (locator or `{x,y}`)  | —                                                                           |
| `pinch`                                                                                      | `scale: number > 0`                | `options.durationMs`                                                        |
| `pressKey`                                                                                   | `key: string`                      | —                                                                           |
| `back`                                                                                       | —                                  | —                                                                           |
| `screenshot`                                                                                 | —                                  | `name`                                                                      |
| `aiAssert`                                                                                   | `rubric: string`                   | `name`                                                                      |

Capabilities, per driver and platform. The UI MUST consult this via `DriverCapabilities` and disable
unsupported actions **with the reason shown**, never silently downgrade them:

| Action                                       | Maestro                                                                                                                                                                                                                                                                     | Appium Android                                                                                                                                             | Appium iOS                                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| tap / fill / longPress / swipe / waitFor     | ✅                                                                                                                                                                                                                                                                          | ✅                                                                                                                                                         | ✅                                                                                                                     |
| doubleTap                                    | ✅ `doubleTapOn`                                                                                                                                                                                                                                                            | ✅ `mobile: doubleClickGesture`                                                                                                                            | ✅ `mobile: doubleTap`                                                                                                 |
| eraseText                                    | ✅ tap + `eraseText` in one call; `characters` honoured                                                                                                                                                                                                                     | ✅ `clearValue`, or n paired key down/up actions for a partial erase                                                                                       | ✅ same — `keys('\uE003'.repeat(n))` works on Android and WebDriverAgent rejects it, so the pairs are built explicitly |
| hideKeyboard                                 | ✅ `hideKeyboard`                                                                                                                                                                                                                                                           | ✅ `mobile: hideKeyboard`                                                                                                                                  | ✅ `mobile: hideKeyboard`                                                                                              |
| scrollUntilVisible                           | ✅ its own primitive, stops as soon as the element is visible                                                                                                                                                                                                               | ✅ bounded look-then-scroll loop (no primitive exists; `UiScrollable` only accepts a `UiSelector` and `mobile: scroll`'s predicate form needs a container) | ✅ same                                                                                                                |
| scroll                                       | ✅ direction honoured (a directional swipe, since bare `scroll()` only ever scrolls down); `within` **refused** with a clear error — Maestro's swipe has no element target, and pretending otherwise would generate a test that only appears to scroll the chosen container | ✅                                                                                                                                                         | ✅                                                                                                                     |
| drag                                         | ✅ (percent-point swipe)                                                                                                                                                                                                                                                    | ✅                                                                                                                                                         | ✅                                                                                                                     |
| pinch                                        | ❌ no primitive                                                                                                                                                                                                                                                             | ✅                                                                                                                                                         | ✅ (needs a target element)                                                                                            |
| pressKey                                     | ✅                                                                                                                                                                                                                                                                          | ✅ (keycode map)                                                                                                                                           | ⚠️ `home`/`volume*` only                                                                                               |
| back                                         | ✅                                                                                                                                                                                                                                                                          | ✅                                                                                                                                                         | ❌ no hardware back                                                                                                    |
| isVisible / assertVisible / assertNotVisible | ✅                                                                                                                                                                                                                                                                          | ✅                                                                                                                                                         | ✅                                                                                                                     |
| screenshot                                   | ✅ (JPEG)                                                                                                                                                                                                                                                                   | ✅ (PNG)                                                                                                                                                   | ✅ (PNG, Retina pixels ≠ logical points)                                                                               |
| aiAssert                                     | ✅ capture only                                                                                                                                                                                                                                                             | ✅ capture only                                                                                                                                            | ✅ capture only                                                                                                        |
| hierarchy / liveFrames                       | ✅ / ✅                                                                                                                                                                                                                                                                     | ✅ / ✅                                                                                                                                                    | ✅ / ✅                                                                                                                |

Two consequences worth stating explicitly: coordinate-only locators reach the adapters **routinely** (the
hit-test misses whenever the tree is stale or the tap lands in dead space), so every adapter MUST
implement a coordinate path for `tap`, `fill`, and `longPress`; and `aiAssert` only captures at record
time — the rubric is evaluated in the generated test by `@pwtap/plugin-ai-judge`, so codegen MUST NOT
emit a rubric assertion unless that plugin is installed, and MUST use a unique variable name per
occurrence.

---

## 6. Recording engine

State is split into five owners; the 731-line god object is dissolved.

| Owner           | Responsibility                                                                         | Must not                        |
| --------------- | -------------------------------------------------------------------------------------- | ------------------------------- |
| `DeviceSession` | connect/disconnect, device lock, frame + hierarchy capture, adaptive schedule, backoff | know about source code or files |
| `Recorder`      | the append-only action log, undo/redo cursor, `matchedBy` metadata                     | perform I/O                     |
| `Draft`         | the single authoritative source string + monotonic revision + ownership flag           | be cleared by a device event    |
| `TestWriter`    | AST save/append, formatting, atomic write, confinement                                 | spawn processes                 |
| `TestRunner`    | project/gate resolution, argv spawn, output streaming, cancellation, temp cleanup      | touch the draft                 |

**Timeline is event-sourced.** Actions are appended with stable ids; undo/redo is a cursor over that log,
not two stacks — the current two-stack model silently discards the redo stack on any non-append edit.

**Draft ownership is explicit and durable.** The draft has one writer at a time: generated (regenerated
from the log on every change) or user-owned (the user typed). Once user-owned, timeline changes are
applied as AST insertions, and the UI MUST be told the draft diverged rather than being handed a source
it will not display. A device disconnect MUST NOT clear the draft, the timeline, or the revision —
losing recorded work on a `run` (which disconnects first) is the single worst current defect.

**Action lifecycle:** validate → refresh hierarchy → hit-test → perform → capture frame → append with
`matchedBy` → emit timeline + draft. A failed action is reported and **not** appended.

**Nothing fails silently.** This is the through-line of the entire audit that produced this document: the
worst defects were not crashes, they were _silences_ — dropped taps, discarded scroll directions, a
cleared editor, a tap answered only by a `warn` line in a panel nobody had open. Therefore: every
rejected, degraded, or failed operation MUST surface in the UI at the place the user acted, with a cause
and, where one exists, a next step. A `log('warn', …)` is diagnostics, **not** user feedback, and MUST NOT
be the only response to a user-initiated action.

**Session death is a first-class state.** The app under test can crash, be killed, or restart; the
Appium/Maestro session then starts failing every call. The engine MUST detect repeated driver failures,
move to an explicit `session-lost` state, stop polling, and offer reconnect — **keeping the timeline and
the draft intact**, because the recording so far is still valuable and is exactly what the user would
otherwise have to redo by hand.

---

## 7. Locator engine

Ranking stays deterministic and explainable: accessibility id (92) > resource id (80) > text (58) >
coordinate (12), −25 and a warning when a candidate is not unique, coordinates always last and always
flagged. On top of today's engine:

- **Uniqueness scope.** Uniqueness is evaluated against the whole tree, which used to discard perfectly good
  locators inside a repeated list row: every attribute of the row was non-unique, so the only candidate that
  survived was a raw coordinate. **Done, as an ordinal rather than a parent scope.** `MobileLocator.index`
  selects among the matches, which both drivers express natively (Maestro's `index`, WebdriverIO's match
  list), and the engine offers it as an extra candidate at `base − 10` — below anything genuinely unique,
  above the coordinate it replaces — with a warning that it is position-dependent. A parent-scoped candidate
  was the other option and is **not** taken: expressing "inside the ancestor with this id" needs Maestro's
  `childOf`/`containsChild` or an Appium XPath, neither of which the other driver has, so a recording made
  with one would only replay under that one — the thing §3 exists to prevent. `native` remains for anyone who
  wants that trade deliberately.
- **Hit-test policy** (already correct, stated so it is not "simplified" away): prefer the smallest
  containing node that _has_ a stable locator over the smallest containing node overall — native trees
  bury anonymous implementation children inside actionable parents.
- **Text warnings.** Long text is flagged as dynamic/localized; recorded text locators are an i18n
  liability and the UI must say so.
- **App scope is part of a locator's confidence.** Found while closing the Phase 0 gate: the hierarchy is a
  whole-screen capture, so it includes other apps' elements — status bar, notification shade, system dialogs.
  Tapping one during recording can succeed while the replay fails, because a driver is scoped to an app id.
  A node whose `appPackage` differs from the app under test therefore loses 60 points and carries an explicit
  warning. **Partial by platform:** Appium Android reports the owning package per node (exact); Maestro's
  compact node does not, so it is inferred from an Android resource-id prefix and is absent for nodes without
  one — which is precisely the case that bit us (a status-bar element identified only by content-desc).
- Node `key`/`path` from ADR-007 is produced here, during normalization.

---

## 8. Code generation and file placement

**Project taxonomy: one extension per driver.** A test file's extension names the driver that runs it —
for hand-written and inspector-generated tests alike. There is no separate driver-neutral extension or
project:

| Extension      | Project   | Gate        | Content                                                                                                                     |
| -------------- | --------- | ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| `*.maestro.ts` | `maestro` | `MAESTRO=1` | every Maestro-driven test: hand-written raw `maestro` API **and** inspector output whose `mobileTarget.driver` is `maestro` |
| `*.appium.ts`  | `appium`  | `APPIUM=1`  | the same for Appium (keeps its `timeout: 180_000`, which the first XCUITest session needs to build WebDriverAgent)          |

Why this over a driver-neutral `*.mobile.ts` + `mobile` project: the extension, the Playwright project,
the gate env var, and the teardown project all line up, so a saved recording lands on the right timeout
and the right device cleanup **automatically**, with nothing to configure. A mis-saved file is obvious
from its name and fixable with one `git mv`. A future driver (Espresso, XCUITest) brings its own
extension and project without touching this table.

Accepted trade-off: retargeting a generated test at another driver is a one-line change to
`mobileTarget.driver` **plus** a file rename, because the code itself is driver-neutral while the file
name is not.

Consequences the implementation MUST honour:

- **Save** picks the extension from `mobileTarget.driver`; the `new`-mode path appends the driver's
  extension rather than a fixed one.
- **The "append to existing file" picker** enumerates every driver extension, not just one.
- **Run** derives both the project and the gate from the driver — `--project=maestro` with `MAESTRO=1`,
  `--project=appium` with `APPIUM=1` — and writes its temp file with the matching extension.

This is a **breaking rename** for existing hand-written Maestro tests, which use `*.mobile.ts` today
(including the shipped `settings.mobile.ts` example): plugin-maestro's project narrows from
`/.*\.mobile\.ts$/` to `/.*\.maestro\.ts$/`, so those files stop being collected until renamed. §13
carries the migration.

**Run.** `TestRunner` MUST spawn the project-local Playwright with `test <file> --project=<driver>` and
that driver's gate variable in the env (`MAESTRO=1` / `APPIUM=1`), both derived from
`mobileTarget.driver`.

The current failure mode is worth recording precisely, because the obvious diagnosis is wrong. Today's
temp file is `tests/.inspector-run-<ts>.spec.ts`, and the leading dot is **not** the problem: Playwright's
directory walker skips only `.`/`..`, `.gitignore`, and `node_modules`, and `createFileMatcher` runs
minimatch with `{ dot: true }`, so the file is collected normally. The damage is the **extension plus the
missing `--project`**: `*.spec.ts` matches the root `testMatch`, so a mobile test is collected by the
`chromium` project and executed with browser fixtures, while the mobile projects stay gated off because
neither `--project` nor the gate env var is passed.

Therefore the temp file MUST match the target project's `testMatch` —
`tests/__inspector__/run-<id>.<driver>.ts` — and MUST be removed on every exit path, with a sweep of stale
leftovers when the service starts (a crash must not leave a file that a later `npm test` picks up).

It MUST NOT be added to `.gitignore`: Playwright's `respectGitIgnore` defaults to
`!projectConfig.testDir && !config.testDir`, so it is `false` only because the core template happens to
set `testDir`. A project that drops `testDir` would flip it to `true` and a gitignored temp file would
silently stop being collected. Relying on that default is a latent trap; deleting the file is the
mechanism, gitignore is not.

---

## 9. UI

Three panes (device / source / accessibility tree) plus a bottom drawer (timeline, run output, logs) is
the right shape and is kept. Required changes beyond the state-model fixes above:

- **Capability-aware controls.** Every action control reads `DriverCapabilities` and renders disabled
  with the reason when unsupported (Maestro pinch, iOS back).
- **Swipe fidelity.** A recorded drag MUST carry how far the finger travelled, as a fraction of the swept
  axis, so a short flick and a long pull do not record identically. **Done**, now that `SwipeOptions.distance`
  is honoured by both adapters (it was dead in both). The **start point is still not carried**: `SwipeOptions`
  has no such field, and a swipe that begins near the top edge can mean something different from one that
  begins mid-screen (pull-to-refresh versus scroll). Expressing it needs either a field on `SwipeOptions` or
  recording the gesture as a `drag` between two points, which both adapters already support but which
  generates a coordinate-based and therefore fragile step. Open.
- **Bounded state.** Logs are a ring buffer (2 000 entries); run output is capped (5 000 lines / 2 MB)
  with explicit truncation notice. Neither may grow without bound.
- **Accessibility.** The connection drawer MUST use `inert`, not `aria-hidden`, while closed — its inputs
  stay focusable today, which is a WCAG 4.1.2 failure. The locator menu needs arrow-key navigation, a
  focus trap, `Escape` to dismiss, and focus restored to the invoking element.
- **In-app pickers** replace native dialogs (ADR-001): project-confined directory browsing and the
  existing-test list across every driver extension (§8), both server-driven.
- **Recording is an explicit act, driving the device is not.** A plain click on the viewport performs the
  interaction and records nothing; ⌘/Ctrl + click records it. The reason is that the viewport is also how the
  user _reaches_ the screen they came to record, so recording every click handed them a test whose first half
  was the trip there, to be deleted by hand. A **Record** toggle inverts the default (and is the
  keyboard-reachable equivalent of the modifier, which is mouse-only — WCAG 2.1.1); holding the modifier
  always means "do the other thing this once". The locator menu is exempt: choosing a locator from a list
  _is_ the explicit act. Recording nothing also skips codegen, the draft update and the strategy check, so
  navigation is cheaper than recording as well as quieter.
- **Device-level steps need a surface of their own.** `back` and `pressKey` are in the IR and supported by
  both drivers, and neither the screen nor an element context menu can express "press Home" — so they were
  unreachable from the UI entirely. A small toolbar under the viewport carries them, under the same record
  gate.
- **The element panel shows what the driver sees.** The ranked candidates answer "how do I address this";
  the node's own attributes (class, text, a11y id, resource id, package, bounds, enabled) answer "is it even
  the thing I meant", which a score cannot. They arrived with every hit-test already and were discarded.
  **Platform gap, measured rather than assumed:** Maestro reports no class name at all on iOS — every node in
  a 144-node Safari tree came back with `cls` absent, while the same driver fills it on Android — so on that
  one combination the panel has no class to show and the tree falls back to `node` as a label. Node identity
  is unaffected (ADR-007's key still has the path plus the ids); this is a display gap, and closing it would
  mean a second source for class names that only one driver on one platform needs.
- **The editor completes from the device.** `mobileApp`'s methods, and locator literals built from the live
  hierarchy. This is the completion a generic TypeScript editor cannot offer, and the alternative — reading an
  id off the tree panel and typing it back — is exactly where a typo becomes a locator that silently never
  matches.
- **The timeline is walkable.** Each recorded step remembers the frame the screen showed once it had run, so
  clicking a step shows that screen. A pinned step is **read-only**: the coordinates on a past screen do not
  address the live one. Retention is bounded (§11) and a step whose frame has aged out says so rather than
  rendering blank.
- **The accessibility tree comes up three levels deep.** Every node used to start expanded, so a native
  screen rendered several hundred rows — mostly anonymous layout containers — and paid for all of them on
  every update. A collapsed branch shows its child count, and a filtered tree expands fully, since its rows
  are the matches.

---

## 10. Protocol

The message _shapes_ are the boundary and stay transport-neutral, so a VS Code webview can speak them
unchanged; the wire itself is SSE + POST + an image endpoint (ADR-013). There is exactly **one**
definition of those shapes — the hand-maintained duplicate in `ui/src/protocol.ts` is replaced by a build
alias to the single source.

Changes from today:

| Message                   | Change                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `isVisible`               | new **action kind** (carried by `perform`/`record`, not a message of its own)      |
| every client command      | gains a monotonic `seq`; the server rejects out-of-order arrivals (ADR-013)        |
| every server event        | gains a monotonic id so `EventSource` can resume from `Last-Event-ID`              |
| `frame` (server)          | carries metadata + id only; the image bytes move to `GET /frame/<frameId>`         |
| `frameUnchanged` (server) | new — dedup signal; the id simply repeats and the browser reuses its cached image  |
| `actionResult` (server)   | gains `matchedBy` (which locator/node the server actually acted on)                |
| `hierarchy` (server)      | nodes gain `path` + `key` (ADR-007)                                                |
| `listDirs` / `dirs`       | new — project-confined directory browsing for the in-app picker                    |
| `draftState` (server)     | new — explicit `generated` / `user-owned` + divergence flag                        |
| `tapAt` / `inspectAt`     | `frameId` becomes advisory (diagnostics), never a rejection reason                 |
| `disconnected` (server)   | MUST NOT imply clearing draft/timeline on the client                               |
| `tapAt` / `perform`       | gain optional `record` — drive the device without writing a step down (§9)         |
| `timeline` (server)       | carries `TimelineEntry[]` (id + action + the frame the step produced), not actions |
| `connectProgress`         | new (server) — which stage of a connect is running, so a slow boot is not a hang   |
| `connected` (server)      | gains `warnings` — e.g. a device handle that will not survive a reboot             |
| `connect` (client)        | every option type-checked, not just `platform`; unknown fields dropped (ADR-010)   |

---

## 11. Non-functional requirements

Measured, not aspirational. The deterministic rows — dependency footprint and published size — are enforced
by `npm run nfr` in CI; the frame, log and poll bounds are unit-tested; the latency and idle-CPU rows need a
real device, so they are measured by hand with `PWTAP_DEVICE=1 npm run test:device` (§12).

**Measured p50 of 5 samples, host M-series macOS.** All four combinations in one sweep: Android emulator
`pixel9`, iOS simulator iPhone 16 Pro (18.6). The `before` column is the original Android-only measurement on
a different image (Pixel 9 API 36), so the driver-floor rows are indicative rather than strictly comparable —
the interaction rows are what this work changed.

| Phase                      | Maestro Android (before → after) | Maestro iOS | Appium Android (before → after) | Appium iOS |
| -------------------------- | -------------------------------- | ----------- | ------------------------------- | ---------- |
| `inspectHierarchy`         | 107 → 101 ms                     | 199 ms      | 22 → 29 ms                      | 386 ms     |
| `captureScreen`            | 182 → 184 ms                     | 176 ms      | 130 → 130 ms                    | 60 ms      |
| **click → code on screen** | 3 → 107 ms                       | 205 ms      | 45 → 25 ms                      | 381 ms     |
| **click → screen moves**   | 1510 → 1083 ms                   | 1370 ms     | 194 → 388 ms                    | 854 ms     |

The tap itself still belongs to the driver: Maestro runs each command as its own flow over MCP and charges
~420 ms for the privilege, which no change on this side removes. What changed is everything around it — the
settle is one look when the driver reports `settled`, the post-action hierarchy is read once instead of twice,
and Maestro carries `waitForAnimationToEnd` inside the same call — and on Maestro that is **1510 ms → 1083 ms**
(896 ms on a quieter run) for the thing a user actually waits for.

**`click → code` needs reading, not quoting.** It tracks `inspectHierarchy` on every one of the four
combinations, and for one reason: the harness replays the _same_ frame id for all five samples, so every
sample takes the stale-frame branch and re-reads the tree before hit-testing. That is deliberate on both
sides — ADR-006 re-reads when the client's frame is not the device's current one, because the alternative is
hit-testing a screen the user is no longer looking at — but it means the ≤100 ms budget below is met **for a
click against a current frame** (where the hit-test is local and the old 3 ms still stands), not for one
against a stale frame, where the floor is whatever that driver's hierarchy read costs. On Appium iOS that is
386 ms, the worst number in this table and entirely XCUITest's page source. Worth revisiting only if it is
felt in practice: the honest fix is a cheaper staleness test, not a faster tree.

`click → screen moves` on Appium Android (194 → 388 ms) is that same stale-frame read plus emulator variance
rather than a schedule regression: Appium reports no `settled`, so it keeps the two-look schedule either way,
and the change took a hierarchy read out of it.

Refresh the numbers with:

```bash
PWTAP_DEVICE=1 npm run test:device                          # maestro / android
PWTAP_DEVICE=1 PWTAP_DEVICE_DRIVER=appium npm run test:device
```

which prints a `[device] <driver>/<platform> p50 — …` line per run (see `inspector.device.test.ts`).

**Frames on disk, measured the same way.** Five Appium captures through the old path left five PNGs in the
temp directory and 1.8 MB of base64 per frame; the same five through the new one leave none. The file round
trip was never the _latency_ problem — `takeScreenshot()` and `saveScreenshot()` + `readFile` measure 488 ms
and 485 ms p50 on the same device, i.e. indistinguishable next to the driver's own screenshot call. It was an
unbounded write of ~1 MB per poll tick against a §11 budget of three files.

| Budget                                                                | Target                                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Install size added to a client project that never opens the inspector | **≈ 0** (`@pwtap/mobile-core` only; no Electron, no `ws`, no formatter)                          |
| Install size added by the inspector devDependency                     | ≤ 5 MB                                                                                           |
| Hover highlight latency                                               | ≤ 1 animation frame, no round trip                                                               |
| click → generated code, p50                                           | ≤ 100 ms, and independent of the driver — it MUST NOT wait for the device                        |
| tap → updated frame, p50                                              | ≤ 1.5 s Appium · ≤ 3 s Maestro                                                                   |
| Idle CPU, connected and untouched                                     | < 5 % of one core                                                                                |
| Idle poll interval                                                    | adaptive, ≥ 750 ms, ≤ 5 s; ≤ 30 s while failing                                                  |
| Retained screenshot files per session                                 | ≤ 3 (ring); temp dir removed on close. Live frames write no file at all                          |
| Retained step frames (memory)                                         | ≤ 50 (~7 MB); the oldest step loses its screen and the UI says so                                |
| Frame payload                                                         | ≤ 2 MB of image bytes served from `/frame/<id>`; never base64; identical frames never re-fetched |
| Duplicated tooling                                                    | none — nothing bundled that `core-template/manifest.json` already gives the project              |
| Client memory                                                         | logs ≤ 2 000 entries, run output ≤ 5 000 lines / 2 MB                                            |
| Dropped user interactions                                             | **0** — no interaction may be discarded for frame staleness                                      |

---

## 12. Phases and exit criteria

A phase is done when its exit criterion is demonstrated, not when its code is written.

**Phase 0 — Runtime contract.** ADR-003, ADR-004, ADR-012, §8 project taxonomy. Fixture wiring and
dedupe, `mobileTarget`/`mobileApp` naming, codegen emits `platform`/`appId`/stable device name, the
device-name resolver, `isVisible` action in the IR and both adapters, `TestRunner` project/gate
resolution and temp path. The `node --test` harness and the fake driver adapter land here too — without
them nothing after this phase is verifiable in CI.
→ **Exit: MET.** A flow recorded in the inspector, saved, and then run from the CLI passes on a real device for
both drivers — re-verified in the field session that produced the `device`/`appId` fixes, where the generated
Appium test ran green inside the user's own project.

**Phase 1 — Host migration.** ADR-001, ADR-008, ADR-011, ADR-013, ADR-014. Split `@pwtap/mobile-core`
out, move the inspector to a devDependency, delete `electron`, `ws`, and `bin/inspect-electron.mjs`,
rebuild the service on SSE + POST + the frame endpoint, launch the UI in a Playwright Chromium app
window, session-per-launch with reattach and single-instance locking, in-app pickers, clipboard, and
resolve `prettier`/`typescript` from the project instead of bundling them.
→ **Exit: MET, with two of its own clauses corrected.** No `electron` and no `prettier` reach a scaffolded
project, enforced by `npm run nfr`; install delta is 1.0 MB against a 5 MB budget; a browser reload
mid-recording keeps the device session, the timeline and the draft, now covered by a UI test. Two clauses were
wrong as written: `ws` arrives through `webdriverio`, which is the Appium client's business and not ours to
ban, so the check bans it only as our OWN direct dependency; and "opens the window on macOS **and Linux**" was
never achievable — `@pwtap/platform` implements macOS only (§2).

**Phase 2 — Recording core.** ADR-005, ADR-006, ADR-007, §6. Split the god object, new frame schedule and
dedup, event-sourced timeline with cursor undo/redo, durable draft ownership, AST codegen, node keys. The
capability gates and the §9 accessibility items landed here too, since both are UI work on the same
components: the save dialog browses real directories, refused actions are disabled with the driver's own
reason, and the ADR-010 path confinement is shared by save and browse.
→ **Exit: MET.** A scripted 200-interaction run against the fake driver drops zero actions — asserted for
identical taps, for a mixed script of every recordable kind, and for undo/redo across a hundred steps, with
the frame schedule running underneath so most interactions arrive against a frame that has already moved. The
§11 latency and idle-CPU budgets are measured above (idle CPU 0.17 % Maestro / 1.56 % Appium against a 5 %
budget). `run` never clears the draft.

**Phase 3 — Quality, security, docs.** ADR-009, the remaining ADR-010 items, the test strategy below, and
READMEs for `@pwtap/mobile-core` and `@pwtap/mobile-inspector` (neither had one).
→ **Exit: MET, with the device matrix verified by hand.** CI is green on `tsc -b`, `eslint`, the suite and the
NFR checks. All four combinations — Android × {Maestro, Appium} and iOS × {Maestro, Appium} — were driven
end-to-end on real devices: connect, record, reload mid-session, record again, save, run.

**There is no device workflow, and that is a decision rather than an omission.** `device.yml` ran the matrix
nightly for months and **failed 21 consecutive nightlies without passing once** — never because the code was
wrong. A gate that is always red is not a gate: it stops being read, and then a real failure hides in it.

What it kept failing on, and why none of it was ours: the iOS jobs booted a simulator by name
(`xcrun simctl boot 'iPhone 16 Pro'`) and the image moved to Xcode 26, whose simulators are iPhone 17/17e/16e
— `Invalid device or device pair`, before a test ran. The Android jobs were on macOS runners that expose no
hypervisor to the VM, so the emulator never started (`HVF error: HV_UNSUPPORTED`) and each job spent twelve
minutes watching `adb` look for a device that was not coming. Both Appium legs would have failed even then,
at "Appium CLI not found" — the adapter spawns a global `appium` plus a platform driver and no runner ships
either; the boot failures had masked that for weeks. Every one of those is a hosted-runner fact that changes
underneath the repository on someone else's schedule.

**The tests remain**, and they are the part with value: `packages/mobile-inspector/test/*.device.test.ts`,
run on demand against a device you already have.

```bash
PWTAP_DEVICE=1 npm run test:device                              # maestro, Android, Settings
PWTAP_DEVICE=1 PWTAP_DEVICE_DRIVER=appium npm run test:device
PWTAP_DEVICE=1 PWTAP_DEVICE_PLATFORM=ios npm run test:device
```

They skip without `PWTAP_DEVICE=1`, so a normal run is unaffected, and they assert without mutating —
nothing is installed and no device is shut down. `--test-concurrency=1` is not optional there: `node --test`
runs files in parallel, there is one device, and the loser of that race reports a lock timeout rather than
anything true.

What CI keeps is the layer that can be trusted to mean something on a hosted runner: the fake driver covers
the whole recording engine, `smoke:mcp` drives the real server over real stdio, and the UI row drives a real
browser. The device matrix is a release check a human runs, and §12's exit criterion above records the last
time all four combinations were driven end to end.

### Test strategy

The enabling piece is a **fake driver adapter** implementing `MobileInspectorDriver` over a scripted
hierarchy and canned screenshots. It makes the entire recording engine testable in CI with no device, and
it is a Phase 0 deliverable, not an afterthought.

**A UI row was missing and it cost two shipped defects.** Both were in the seam between the page and the
service — where the service tests speak the protocol correctly by construction and the engine tests never
load a page — so nothing in the suite could see either. A recorder is a browser application; the browser MUST
be in the loop somewhere. The UI row below uses the same fake driver, needs no device, and runs in CI after
the UI bundle is built and a Chromium installed.

| Layer                                         | Covered                                                                                                                                                                                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit (pure, golden-file where output is text) | locator ranking and warnings, hit-test policy, node key/path derivation, codegen output, AST append/merge, protocol field validation (including malformed payloads), draft revision state machine, `imageSize` on real PNG/JPEG headers |
| Integration (fake driver)                     | connect → tap → timeline → codegen → save → run with a stubbed Playwright binary; disconnect-does-not-clear-draft; no dropped interactions under load                                                                                   |
| UI (real browser + fake driver)               | reload keeps recording, the picker's serial still becomes an AVD name in codegen, a refused action is stated on screen, a second view takes over instead of going deaf                                                                  |
| Device-gated (manual, opt-in)                 | Android emulator × {Maestro, Appium} and iOS simulator × {Maestro, Appium} record→save→run smoke, plus the MCP server's connect→disconnect→reconnect cycle. Not in CI — see §12                                                         |

---

## 13. Versioning, release, and migration

These are **published** packages at **1.0.0** (`@pwtap/mobile-inspector`, `@pwtap/plugin-maestro`,
`@pwtap/plugin-appium`, `@pwtap/platform`; `@pwtap/create` trails at 0.4.x), so what follows is a
coordinated multi-package release, not a refactor behind a curtain. Past 1.0 the bumps are real semver:
anything that breaks a consumer is a **major**, not a "breaking minor".

**Package moves.** `@pwtap/mobile-core` starts at `1.0.0` so it lines up with the packages that depend on
it. `@pwtap/mobile-inspector` takes a **major** that removes its runtime surface, keeping **type-only
re-exports** from mobile-core for one minor so anyone who imported types from it gets a deprecation rather
than a build error. The plugins take a minor: dependency swapped to `@pwtap/mobile-core`, and the inspector
moves to a manifest-injected devDependency.

**Release order is load-bearing:** mobile-core → adapters built against it → inspector → `@pwtap/create`
manifests. Publishing an adapter that requires a core version not yet on npm is the one sequencing
mistake that breaks fresh installs, and it is not recoverable by a follow-up patch.

**Breaking changes, each needing a changeset with migration text:**

1. `mobile` option → `mobileTarget`; the facade fixture → `mobileApp` (ADR-003). No known users, because
   the record→run loop never worked — but the changeset states it explicitly rather than relying on that.
2. Maestro tests move from `*.mobile.ts` to `*.maestro.ts` and the `maestro` project's `testMatch`
   narrows to match (§8). **No codemod** — this closes an earlier open question: the change is one
   `git mv` per file plus a project block that `create-pwtap add maestro` re-injects anyway, so a codemod
   carries more risk than the rename it automates. The changeset ships the command verbatim:

   ```bash
   git ls-files 'tests/**/*.mobile.ts' | while read -r f; do
     git mv "$f" "${f%.mobile.ts}.maestro.ts"
   done
   npx @pwtap/create add maestro   # re-injects the narrowed project block
   ```

   Nothing inside those files changes: the `mobile` option and the `maestro` fixture they use are
   plugin-maestro's own and are untouched by this work.

3. `electron` leaves the dependency graph; `mobile-inspect` opens a Playwright Chromium window. A user
   with no browser downloaded MUST get an actionable `npx playwright install chromium` message, not a
   launch stack trace.
4. `MOBILE_CORE_CONTRACT` (ADR-009) starts at `1`; the registry's refusal message names the exact package
   and version to upgrade.

**Fixture-barrel ownership** (also closing an earlier open question): there is no new Playwright project
to own — each driver keeps its own (§8). What must be injected exactly once is the `mobileApp` fixture
fragment, **owned by `@pwtap/mobile-core`** and referenced by both plugin manifests under a shared dedupe
key, so installing either plugin — or both — merges it into `@fixtures` a single time.

---

## 14. Open questions

1. ~~**The `native` locator strategy.**~~ **Decided: hand-authored only, never ranked.** A native selector is
   specific to one driver on one platform by definition, so emitting one from the recorder would produce a
   recording that replays only under the driver that made it — the opposite of the premise in §3. The ranking's
   job is to order _portable_ identifiers by how well they survive a redesign, and a native selector has no
   comparable durability to score. `MobileLocator.native` stays as the escape hatch for what the IR cannot
   express, and both adapters pass it through untouched; `LocatorCandidate.strategy` no longer lists it, since
   the engine never produced it and a type promising a case that cannot happen forces dead branches on every
   consumer.
2. **Frame re-encoding:** the server serves the raw capture bytes by default; whether it should
   down-scale or re-encode oversized Retina PNGs, and at what threshold, is a Phase 2 measurement against
   the §11 frame-payload and latency rows. **Decided: no re-encoding.** Measured at ~150 KB per capture
   against a 2 MB budget, so it buys nothing; revisit only if a higher-density device changes the number.
3. **A recorded journey cannot start cold.** `connect` launches the app, and the fixture does the same on
   replay, so a recording that begins on the home screen replays as launch → Home → tap the icon → the app
   opens again. Correct and deterministic, but redundant, and it is not the flow a user recording a cold
   start means. A `mobileTarget.launch: false` would express it. Deferred because it changes the fixture's
   contract and two things still need deciding: what a replay should do when the app is not running (fail
   loudly, or launch anyway and lose the point); and whether Appium — which already attaches to whatever is
   foregrounded when given no app id — is made to agree, since two drivers disagreeing about what
   `launch: false` means is worse than not having it.

   One of the three original blockers is gone: "Maestro needs an app id for every flow header" turned out to be
   "Maestro needs a _header_", and `appId: any` is a valid one (ADR-003's app-identity clause). Suppressing the
   launch while keeping `appId` for the header is therefore expressible today; what is left is a product
   decision, not a driver limitation.

4. **VS Code webview host — deferred, recorded as an improvement.** Hosting the inspector inside VS Code
   instead of its own Chromium window: recording where the test is written, next to the file it lands in. The
   protocol is already built for it — §10's message shapes are transport-neutral, and `RecorderSession.dispatch`
   takes "a validated command, whatever host delivered it", so a webview would speak them unchanged over
   `postMessage` instead of SSE + POST. **Costs nothing to leave alone:** nothing has to be built to keep that
   true, so deferring accrues no debt.

   Deferred because it is a product commitment, not a fix, and three costs land with it: a second distribution
   channel (Marketplace, its own release cadence, tracking extension-API breakage — the kind of weight removing
   Electron was meant to shed, ADR-001); two transports alive at once in the UI, when the single one it has
   today already produced two field defects; and the extension host's own lifecycle to reconcile with ADR-011's
   session-per-launch. The gain is real but narrow: staying in the editor.

   **Recommendation: not now**, on sequencing rather than taste — the inspector met its first real user one
   round ago and that round found two defects, so doubling the surface is premature. If editor integration is
   wanted sooner, there is a far smaller step that needs no extension at all: open the saved file in the
   system editor after a save.

5. **Capturing frames through `adb` instead of the driver.** Measured on Android: the Maestro adapter's
   `captureScreen()` costs 181 ms against 130 ms for `adb exec-out screencap` — the whole difference is the MCP
   round trip, since writing and re-reading the PNG is free. That is ~50 ms twice per interaction.
   **Recommendation: do not**, for now: it adds a second capture path, Android-only, to the layer that has
   already produced two field defects, for about 8 % of click→screen. Revisit if the frame budget tightens.
   (The "writing and re-reading the PNG is free" clause is what made this look like the only lever left. It
   was measured against the MCP round trip and it is true per frame; what it missed is that nothing ever
   deleted those files — see ADR-006. The file is gone now, which does not change this recommendation.)
6. **Maestro Studio's local interface.** Maestro through MCP costs ~420 ms per tap over the device floor,
   because MCP's only interaction tool is `run` — a flow executor, so every tap is a one-line test run — and
   its parameters expose no wait to trim (§11). Studio avoids this by driving Maestro's own daemon instead,
   which is why it feels instant. Reaching that would mean integrating with a local interface Maestro does not
   document and does not expose a port flag for, so we would own every break. **Recommendation: do not**,
   while Appium is one option away at 194 ms click→screen; revisit if Maestro publishes the surface.

   **Re-checked against Maestro 2.6.1** (`tools/list` over `maestro mcp`, and `maestro studio --help`), because
   this is the one recommendation that a Maestro release could overturn on its own. It has not:
   `maestro studio` still takes no port or host flag, and the MCP server still exposes `list_devices`,
   `take_screenshot`, `run`, `inspect_screen`, `cheat_sheet`, `open_maestro_viewer` and the cloud tools —
   `run` remains the only way to interact, and its parameters (`yaml` / `files` / `dir` / `include_tags` /
   `exclude_tags` / `env`) still expose no wait to trim.

   What the re-check _did_ find is that `run`'s `yaml` takes a **multi-line flow**, and the overhead is charged
   per call rather than per line. Two things follow, both taken: `fill` is one call (tap + `inputText`) instead
   of two, and a screen-changing command carries `waitForAnimationToEnd` in the same call, which is what lets
   the recorder settle in one look instead of three (ADR-006). Neither reduces the per-tap floor; both remove a
   whole floor's worth of calls from the interactions that needed more than one.
