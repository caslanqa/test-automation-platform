---
'@pwtap/mobile-inspector': minor
'@pwtap/platform': minor
'@pwtap/mobile-core': minor
'@pwtap/plugin-maestro': minor
'@pwtap/plugin-appium': minor
'@pwtap/create': minor
---

A mobile MCP server: nine tools, no SDK, and one capability an agent cannot get from the shell

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

`npx create-pwtap mcp` prints a configuration block and **never writes one**. A `.mcp.json` we generated
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
