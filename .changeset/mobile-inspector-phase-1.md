---
'@pwtap/mobile-inspector': major
'@pwtap/plugin-maestro': minor
'@pwtap/plugin-appium': minor
'@pwtap/create': minor
---

Take Electron out of the mobile stack, and split the runtime contracts away from the recorder.

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
