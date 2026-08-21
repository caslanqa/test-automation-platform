# @pwtap/platform

## 1.2.0

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

- d9d214a: Linux is a supported host for Android, so the emulator can run where a hypervisor exists

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

## 1.1.0

### Minor Changes

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

### Patch Changes

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

## 1.0.0

### Major Changes

- 5f96d85: mobile inspector issue fix

## 0.3.2

### Patch Changes

- 76bd9d8: Harden mobile-inspector/runtime compatibility and raise the Node baseline.

  - `@pwtap/mobile-inspector` now loads platform APIs through a compatibility bridge so outdated
    `@pwtap/platform` installs fail with a clear upgrade error instead of crashing module load on
    missing named exports.
  - Tighten plugin runtime dependency ranges to mobile-inspector/platform versions that include the
    inspector integration fixes.
  - Raise supported Node version to `>=22.23` across the monorepo's publishable packages.

## 0.3.0

### Minor Changes

- 5e8e969: Add the booted-device registry (`readBootedDevices`/`recordBootedDevice`/`clearBootedDevices`/`stopBootedDevices`), hoisted out of `@pwtap/plugin-maestro` so mobile engines can share it. Tracks the devices a run auto-booted (in a shared tmp file) so a teardown can shut only those down, leaving hand-booted devices untouched; pass `{ keepDevices: true }` to skip the shutdown while still clearing the record.

## 0.2.0

### Minor Changes

- c6df135: Add device system log capture and screen recording primitives, shared by mobile plugins: `clearLogcat`/`dumpLogcat` and `startAndroidRecording` (Android), `logCaptureStart`/`dumpSimLog` and `startSimRecording` (iOS simulator), and the `ScreenRecording` type.

## 0.1.1

### Patch Changes

- d508646: Add per-package READMEs (npm landing pages) and rewrite the root README for the monorepo.

## 0.1.0

### Minor Changes

- Initial public release of the Playwright Test Automation Platform.

  - `@pwtap/platform` — macOS-first platform seam (paths, shell, device discovery/boot, device lock) for plugins.
  - `@pwtap/create` — UI + API core scaffolder with opt-in plugins (`npm init @pwtap`); bundles the editable core template.
  - `@pwtap/plugin-ai-judge` — LLM-as-judge matchers (`toPassRubric`/`toScoreAtLeast`/`toMatchImage`) with prefix-routed multi-provider support (Ollama, OpenAI-compatible gateways, native Claude) and a `registerProvider` escape hatch.
