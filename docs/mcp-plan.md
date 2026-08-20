# The mobile MCP server — plan and decision log

## Context

pwtap consumed MCP before it served it: `plugin-maestro/src/core/McpClient.ts` is a 190-line hand-written
JSON-RPC client that drives `maestro mcp`. This adds the other half — a server that exposes the mobile
platform to any MCP client — and the interesting part of the work was deciding how little to ship.

## What is built

| Piece                                       | Where                                      |
| ------------------------------------------- | ------------------------------------------ |
| JSON-RPC 2.0 over stdio                     | `packages/mobile-inspector/src/mcp/rpc.ts` |
| Nine tools, their schemas and annotations   | `src/mcp/schemas.ts`, `src/mcp/tools.ts`   |
| One session per process, with an idle timer | `src/mcp/session.ts`                       |
| The server                                  | `src/mcp/index.ts`, `bin/mcp.mjs`          |
| Print-only client configuration             | `packages/create/src/commands/mcp.ts`      |

Zero new packages, zero new runtime dependencies.

## Why one server and not four

The test applied to every candidate was: **does this expose a capability an agent cannot already get from
the shell and the filesystem?**

**Shipped: `mobile`.** It passes on one tool. `mobile_locators` returns _ranked, uniqueness-checked,
fragility-annotated_ locator candidates, and no shell command produces that — `adb shell uiautomator dump`
gives raw XML with no scoring. `locatorCandidates` scores 0-100 for stability, checks uniqueness against
the live tree, penalises a non-unique match by 25 and an out-of-app element by 60, offers an index
fallback for a repeated row, and puts coordinates last always flagged fragile. Without it an agent writing
a mobile test writes coordinate taps.

It also passes the _stateful_ half of the CLI-versus-MCP question: a CLI would pay driver spawn on every
call — Maestro is ~420 ms per command plus driver boot, Appium builds WDA on first session — where a warm
`DeviceSession` between tool calls is something a CLI structurally cannot offer.

**Killed: a run/triage server.** `playwright test --reporter=json` is a shell command; the HTML report,
`test-results/`, traces and the healer's run history are _files_. An agent reads a file with a bounded
`Read`; an MCP round trip dumps the whole blob into unbounded context. **Phase 3 therefore has no
dependency on Phase 2 at all.**

**Killed: a separate inspector/codegen server.** `statementForAction` and `generateTestSource` are pure
functions of the action IR, but they need the _connected session's_ target header — driver, platform,
stable device name, app id. A second process would have to re-derive it. Folded in as `mobile_codegen`.

**Killed: a judge server.** The client is already an LLM. A tool that spends the user's API key on a second
model to score text the calling model could score itself answers a question the client can already answer.
The judge's value is entirely in being a _test assertion_: deterministic, content-keyed cache, calibrated
against human labels with Cohen's kappa, CI-gated at `--max-false-pass 0`. Called ad hoc from a chat, none
of that survives.

**Not shipped, deliberately: `@playwright/mcp` and `maestro mcp`.** We cannot improve `npx
@playwright/mcp@latest`, and shipping it means owning its version churn and browser-download failures for
every pwtap user — including the ones with no browser tests. `maestro mcp` is worse than useless to ship:
`McpClient.ts` documents the failure mode in its own `close()` — two `maestro mcp` processes on one device
collide and the driver dies with `Failed to connect to 127.0.0.1:<port>`. The fixture holds
`acquireDeviceLock` for the session lifetime precisely to prevent that, so handing an agent a second,
unlocked one would guarantee the collision. Our server goes through `driver.connect()`, which means
through the lock. That is the whole reason to write one.

## Decision log

- **ADR-015 — Hand-rolled MCP server, no SDK.** Both SDK generations force `zod`:
  `@modelcontextprotocol/server@2` depends on it, `@modelcontextprotocol/sdk@1` has it as a non-optional
  peer. Closure: server 6.01 MB + core 1.25 MB + zod 4.35 MB ≈ **11.6 MB unpacked**, against a package
  that ships **1.15 MB** today with a 5 MB budget. v1 is worse — 17 direct dependencies including
  `express@5`, `hono`, `cors`, `jose`, `ajv`, an OAuth stack, for a stdio server. And `server@2.0.0` went
  GA three weeks before this was written. Against that: ~120 lines whose _inverse_ this repo already
  ships and has debugged. Same shape as ADR-013's decision about `ws`.
- **ADR-016 — The protocol version is pinned to `2025-06-18`.** The newest revision, `2026-07-28`, adds
  `resultType` to `CallToolResult` and says servers implementing it MUST send one. Advertising a version
  whose MUSTs we do not satisfy is worse than advertising an older one we do. `negotiateVersion` echoes
  any version we speak and answers with ours otherwise, which the specification permits.
- **ADR-017 — No instance lock.** `service/instanceLock.ts` exists because two recorders producing
  conflicting _drafts_ corrupt each other (ADR-011). An MCP server has no draft. `@pwtap/platform`'s
  device lock already serialises MCP against the inspector correctly, and adding a second lock would mean
  stretching `LockInfo` around a `port` this server does not have.
- **ADR-018 — `MOBILE_CORE_CONTRACT` stays at 1.** `ConnectOptions.timeoutMs` is an added optional field:
  an adapter that does not read it keeps the thirty-minute default, which is exactly its previous
  behaviour. Bumping the contract would break every adapter's build to announce a change none of them
  need to make.
- **ADR-019 — A tool never throws.** Every failure is `isError: true` with text. A tool result is
  something a model can read and act on; a JSON-RPC error is a transport failure it can only report. This
  was got wrong first — `session.require()` threw straight through the dispatcher — and a test caught it.
- **ADR-020 — No shell, uninstall or erase tool, ever.** MCP tools are approved **by name**, not by
  argument. A `mobile_shell(cmd)` allowed once is a permanent, unaudited escape from the user's own Bash
  permission gate — which does see the real command string. An agent can already run `adb` through Bash.
- **ADR-021 — `env/environments.json` never reaches this server, by construction.** `config/loadEnv.ts`
  is a _core-template_ file called from a scaffolded project's `playwright.config.ts`; nothing in
  `mobile-inspector` or `mobile-core` reads it. So the server does not inherit the user's API keys, database
  passwords or gateway tokens — not by discipline but because there is no path. The one thing that would
  break it is a tool that spawns Playwright, which is exactly the run tool we killed.

## Distribution: derived, never injected

A plugin declares its server in its manifest:

```ts
mcp: [{ name: 'mobile', package: '@pwtap/mobile-inspector', entry: 'bin/mcp.mjs', shared: true }],
```

and the rendered Claude Code plugin emits `.mcp.json` from whatever **resolves** in the client's
`node_modules`. Nothing is written into the user's repository, which is what makes add/remove symmetry
free: `create-pwtap remove maestro` deletes the manifest, the next render omits the server, and there was
never a marker region, a removal path or an idempotence test to get wrong. `shared: true` keeps the entry
when one mobile plugin is removed and the other stays — the same rule `fixture.shared` follows.

Resolution, not declaration, is the check. Claude Code has no conditional component loading, so this is
what stands in for it: a manifest naming a server whose package was never installed produces no entry,
because a configuration the client cannot spawn fails on every session start.

**A trap worth recording, found by rendering against a real installed project rather than by reading the
resolver's rules.** The first probe asked for `<pkg>/package.json` — and a package with an `exports` map
does not export its own manifest, so it failed with `ERR_PACKAGE_PATH_NOT_EXPORTED` for exactly the
packages that are correctly configured. The smoke did not catch it either, because its fake package had no
`exports` map; it has one now, and reverting the fix makes the smoke fail.

Three settings come from the plugin's `userConfig`: `ALLOW_ACTIONS` (default off), `IDLE_MS` and `DEVICE`.
None is `sensitive`, so nothing touches a keychain — this server calls no model and needs no key.

For any other MCP client, `npx create-pwtap mcp` prints an equivalent block and writes nothing.

## Security

Threat model in one line: **the device screen is attacker-controlled input, and an MCP tool name is a
durable grant of authority.**

| Class          | Tools                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| Read-only      | `mobile_drivers`, `mobile_devices`, `mobile_hierarchy`, `mobile_locators`, `mobile_screen`, `mobile_codegen` |
| Session-scoped | `mobile_connect`, `mobile_disconnect`                                                                        |
| Acting         | `mobile_perform`, alone                                                                                      |

- **The action IR is closed**, and validated by the _same_ narrowers the SSE boundary uses
  (`isMobileAction`, `parseConnectOptions`) — one boundary, so the two cannot drift.
- **`locator.native` is rejected here.** `isLocator` passes it through as an adapter escape hatch, which
  is right for a human writing a test and wrong for a model-supplied locator that would reach the driver
  as an arbitrary XPath. Tightened at this boundary rather than in the narrower, because the SSE client
  legitimately needs it.
- **`PWTAP_MCP_ALLOW_ACTIONS` defaults to off**, and `mobile_perform` stays _listed_ when it is. Hiding a
  tool pushes a model to invent a workaround — in practice `adb shell input tap` through Bash. A refusal
  naming the switch pushes it to ask a human.
- **Untrusted material is wrapped** in `<device-material-NONCE>` with a fresh nonce per call, and the
  guard sentence lives in `InitializeResult.instructions` where a client will keep it. The same discipline
  `plugin-ai-judge` applies to a chatbot response, for the same threat.
- **`mobile_screen` returns a path by default.** A screenshot of a logged-in app is a credential: a
  session, a one-time code, a customer record. `frameStore.ts` made the same call for the UI, and it saves
  an enormous number of tokens besides.
- **The tree is bounded** (`maxDepth`, `maxItems`). An unbounded tree is both a token bomb and a larger
  injection surface.
- **Approval is the client's.** A stdio server cannot ask a human anything without `elicitation/create`,
  which is deliberately not implemented — a tool blocking on stdin would be blocking the JSON-RPC channel
  itself. `annotations` is what the client's own permission prompt reads.

## Lifecycle

One `DeviceSession` per process, and the server **never takes the device lock itself** — both adapters
take it in `connect()` and release it in `close()`, so a second acquire here would deadlock against the
adapter. The server's only job is to guarantee `close()` runs.

- **Client disconnect**: stdin EOF. `process.on('exit')` cannot await, so a lock released there would
  never actually be released.
- **SIGINT/SIGTERM**: the same idempotent teardown, with `bin/inspect.mjs`'s re-entry guard.
- **SIGKILL**: nothing can run. The backstop already exists — `lock.ts` steals a lock after ten minutes.
- **Idle**: the one genuinely new mechanism. A person forgets a session open and the device lock blocks
  their own test run for up to thirty minutes with no explanation. `PWTAP_MCP_IDLE_MS` (default ten
  minutes) closes it; every tool call resets the timer.
- **Connect**: `timeoutMs`, defaulting to 120 s rather than the platform's 30 min. A tool call blocked for
  half an hour is indistinguishable from a hang, and there is no cancel. Fixed in the _shared_ function
  rather than by racing-and-abandoning in the caller, which leaks the lock when the abandoned attempt
  later succeeds.

## Verification

```bash
npm test            # mcpProtocol (framing, 11) + mcp (tools and refusals, 22)
npm run smoke:mcp   # the real shipped binary, a real child process, real stdio
npm run nfr         # BANNED_AS_OURS now covers zod and both MCP SDKs
PWTAP_DEVICE=1 npm run test:device   # a full cycle, then connect AGAIN
```

`mcpProtocol.test.ts` covers the class of bug that actually costs time here: a stream delivers bytes, not
messages. One message in three chunks, three in one, a non-JSON line, a message with no trailing newline,
a notification that must draw no reply, and the assertion that every byte written to stdout parses as
JSON-RPC.

`smoke-mcp.mjs` talks to our server with **our own client** — `plugin-maestro`'s `McpClient`, loaded by
filesystem path. Writing a second JSON-RPC client for the test is precisely what ADR-015 argues against
doing for the server. Its most valuable assertion is the third: in a project with no mobile plugin
installed, `mobile_drivers` answers with an empty list and a sentence naming what to install. That is the
most common real first contact, and the place a stack trace would be worst.

The device test's last assertion is the one that justifies the file: connect, disconnect, **connect
again**. Nothing else proves the lock was released, and the way that failure is normally discovered is a
colleague's suite hanging.

## Not in this phase

A judge server. A run/triage server. Any shell, `adb` or `simctl` passthrough. Writing test files from the
server (`mobile_codegen` returns a string; the agent has `Write` — which removes `testWriter.ts`'s
path-traversal surface entirely). HTTP, SSE or WebSocket transport. MCP prompts, resources, sampling,
elicitation or tasks. Shipping `@playwright/mcp` or `maestro mcp` in our own configuration.
Windows-first behaviour.
