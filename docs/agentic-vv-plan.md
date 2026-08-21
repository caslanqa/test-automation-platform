# Agentic SDLC V&V — plan and decision log

## Context

`@pwtap` scaffolds a Playwright project and lets opt-in npm plugins splice themselves into
marker-managed regions. Until this change the repo had no agent-facing surface at all: no
`.claude-plugin`, no `agents/`, no `skills/`, no `marketplace.json`, and the one agent-instruction
file (`.github/copilot-instructions.md`) documented marker names that never existed in the code.

The goal is an SDLC verification & validation agent team that **narrows itself to the test plugins a
project actually installed**, distributed so it stays in sync without anyone running a sync command.

This is Phase 1 of three. Phase 2 is a test-execution auto-healing engine (`@pwtap/plugin-heal`);
Phase 3 ships a mobile MCP server. Phase 3 has **no dependency on Phase 2** — see `docs/mcp-plan.md`
when it lands — and Phase 2 does not depend on Phase 1: agents are a front end over its CLI, never a
requirement for it.

## The constraint that shapes everything

**Claude Code has no conditional component loading.** A plugin is enabled or disabled as a whole;
there is no "load this agent only if…". So "no mobile plugin installed, no mobile agent" is a property
of our renderer or of nothing.

Three further constraints, all verified against the current docs and the installed CLI (2.1.237):

| Constraint                                                                                                                                                                             | Consequence                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A marketplace `command` source runs from the user's **home directory**                                                                                                                 | The renderer cannot see the session's working directory                                                                                       |
| `CLAUDE_PROJECT_DIR` is exported to hook, MCP and LSP subprocesses — a marketplace command is not on that list, and the placeholder-substitution table does not cover `source.command` | The project must be resolved another way (§Project resolution)                                                                                |
| The accepted command string is **frozen**: changing it stops every user's background re-runs until they re-accept                                                                      | All variability lives behind the CLI, never in the string                                                                                     |
| `copy` mode hashes the directory's **contents** to derive the version                                                                                                                  | A stable output path rewritten in place is correct; content-hashed directory names are a `link`-mode requirement and would drag in a cache GC |

## Architecture

```
packages/create/agents/            neutral source, committed (not generated)
  agents/*.md  skills/*.md  commands/*.md   frontmatter + markdown body
  hooks/hooks.json  hooks/check-markers.mjs copied into the render verbatim

packages/create/src/agents/
  frontmatter.ts   flat YAML subset: parse + serialize, no `yaml` dependency
  requires.ts      the capability predicate
  capabilities.ts  ProjectCapabilities + detect()
  defs.ts          load + validate the definition source
  outDir.ts        ~/.pwtap/claude-plugin/<slug>, PWTAP_HOME / PWTAP_AGENTS_OUT overrides
  project.ts       the resolution chain + ~/.pwtap/projects.json
  renderClaude.ts  gating, layout, interpolation, atomic write

packages/create/src/commands/
  claudePluginPath.ts   the marketplace command entry point
  initAgents.ts         the no-plugin fallback

.claude-plugin/marketplace.json   one entry, `command` source
scripts/smoke-agents.mjs          end-to-end gating + contract assertions
```

**No new package.** The renderer's only inputs are `loadPluginManifest()` and `KNOWN_PLUGINS`, both in
`@pwtap/create`. A separate package would force `create` — a bin-only package with no `main`, no
`types` and no `exports` — to grow a published API surface it has never had, and `scripts/nfr-check.mjs`
discovers `packages/*` from the filesystem, so a new directory is classified as **runtime** and
dependency-footprint-checked on creation. Extract `@pwtap/agentic` if the roster passes ~40 files;
everything is already namespaced under `src/agents/` and `agents/` so that move is mechanical.

## The definition format

```
---
name: <kebab>            required; must equal the filename
description: <one line>  required; for an agent or skill this IS the routing signal
requires: <predicate>    default: core
targets: [claude, agents-md, copilot]
tools: [read, search, write, shell, web, task]   neutral vocabulary
model / effort           agents only
owns: [<skill>, …]       agents only → the rendered `skills:` list
subagentOf: <agent>      agents only → composition, rendered as prose
---
body, with {{testsDir}} {{projectDir}} {{script:<name>}} {{ref:<name>}} {{rosterReport}}
```

`kind` comes from the directory. Every unknown frontmatter key, tool and target is **refused at
load** — these are files we ship, so a typo must fail our tests rather than render a plugin that
quietly lost a capability.

Predicate grammar, kept deliberately small: comma or array = AND, `|` = OR within one term, `!`
negates. Tokens are `core`, `plugin:<manifest.id>`, `cap:<name>`. A token of an unrecognised _shape_
evaluates false **and its negation also evaluates false**, so a typo fails closed rather than
switching a component on.

## Capability detection

`detect(projectDir)` returns `null` for anything that is not a pwtap project — a baseline render, not
an error. Installation is decided by **resolution**: `loadPluginManifest()` resolving `<pkg>/manifest`
from the client's `node_modules`, which is the same probe `sharedFixturesToKeep()` uses. A plugin in
`package.json` that does not resolve means `npm install` is pending; its agents stay out and a warning
says why, because enabling them would hand the model scripts that do not work.

Four derived tokens, each gating a real component:

| Token           | Source                                                 | Gates                                     |
| --------------- | ------------------------------------------------------ | ----------------------------------------- |
| `cap:mobile`    | `plugin:appium \|\| plugin:maestro`                    | `mobile-vv`, `mobile-locators`            |
| `cap:ci-github` | `.github/workflows/` exists                            | `release-gate`                            |
| `cap:allure`    | `playwright.config.ts` still names `allure-playwright` | `read-run-artifacts`                      |
| `cap:git`       | `.git/` exists                                         | the diff-reading half of `story-reviewer` |

Anything beyond these four is speculation until a definition needs it.

## Project resolution

First hit wins:

1. `--project <dir>`
2. `PWTAP_PROJECT` — the documented deterministic escape hatch
3. `CLAUDE_PROJECT_DIR` — read opportunistically; if it turns out to be exported here, this becomes
   the primary path and everything below is dead weight, which would be a good outcome
4. `~/.pwtap/projects.json` — written by `create`, `add` and `remove`; one entry is the common case,
   several means most-recently-seen
5. nothing → baseline render, exit 0

`ponytail:` most-recent-wins is wrong for someone alternating two pwtap projects in parallel sessions.
The named upgrade path is `PWTAP_PROJECT`; `/pwtap:vv-status` exists so a wrong roster is explainable
rather than mysterious.

Rejected: reading the parent process's cwd via `lsof`/`/proc`. Platform-specific, fragile, and a
`ps`-scraping test tool is not something anyone should have to debug at 3am.

## The stdout contract

```
render → <outDir>.tmp-<pid>  →  rm -rf <outDir>  →  rename
self-check: .claude-plugin/plugin.json and a non-empty skills/ both exist
process.stdout.write(outDir + '\n')      // the only stdout write on this path
exit 0
```

**`log.info` / `log.step` / `log.done` are banned on the render path.** They are `console.info`, which
is stdout, and one stray call breaks the contract silently for every user.
`packages/create/test/agentsStdout.test.ts` spawns the built CLI and asserts exactly one line, which is
what catches the next person who adds one.

Determinism is a correctness requirement, not a nicety: a byte-different render of the same input
reloads the plugin mid-session and can prompt the user about prompt-cache cost. No timestamps, no
hostnames, no iteration-order dependence; definitions are sorted by kind then name.

## Distribution

```json
{
  "source": "command",
  "command": "npx -y @pwtap/create claude-plugin-path",
  "timeout": 180,
  "mode": "copy"
}
```

39 characters, printable ASCII, no run of four spaces. `--project "${CLAUDE_PROJECT_DIR}"` is
deliberately **not** in the string: the variable is not documented as exported to this process,
`${VAR}` is not `cmd.exe` syntax, and the string is frozen after acceptance. The renderer reads
`process.env.CLAUDE_PROJECT_DIR` itself — same effect, portable, shorter to review, no regret.

`timeout: 180` because a cold `npx -y` resolves from the registry and downloads a package that bundles
the whole core template. `mode: "copy"` decisively: the render is tens of KB, so link mode's only
advantage is irrelevant while its costs are real — path-based versioning, the printed directory having
to survive as long as the plugin, a session started below it silently loading nothing, and no Windows
support at all.

Floor: Claude Code ≥ 2.1.229. Below that the install fails with an unsupported-source-type message,
and on anything older the whole marketplace fails to load — blast radius limited only because we ship
one entry. Also blockable by the managed settings `disableCommandPluginSources`, and blocked by default
under `allowManagedHooksOnly`.

**Fallback:** `npx @pwtap/create init-agents --loop=claude` writes the same components into
`<project>/.claude/`, un-namespaced (`/vv`, `@vv-lead`), with no manifest. It writes **file by file and
never replaces the directory** — that directory holds the user's own agents and `settings.local.json`.
The trade it buys: a component whose capability disappeared stays behind as a stale file, which is why
it is documented as a static snapshot and why the plugin path stages-and-swaps instead.

## Decision log

- **ADR-A1 — Render, do not ship a fixed set.** Conditional component loading does not exist, so
  gating is ours. The `command` source is what makes it automatic rather than a sync command someone
  forgets to run.
- **ADR-A2 — No new package.** See §Architecture. Named extraction trigger: ~40 definition files.
- **ADR-A3 — No `yaml` dependency.** The format is a flat subset; ~60 lines of parse plus serialize,
  and the serializer is not overhead because both the Claude renderer and (later) Copilot need
  frontmatter emitted. Consistent with `VERDICT_SCHEMA` being hand-written JSON Schema.
- **ADR-A4 — Resolution, not declaration, decides "installed".** A half-installed plugin's agents
  would recommend commands that do not run.
- **ADR-A5 — `owns` is a superset and pruning is silent.** Warning on it would print the same three
  lines on every session start of every core-only project. The rendered README's roster table carries
  it instead, which is also what `/pwtap:vv-status` reads.
- **ADR-A6 — Cross-references go through `{{ref:}}`.** Hardcoding `@pwtap:x` in prose is wrong in
  standalone mode, where components are invoked bare. A reference to a gated-out definition is warned
  about — that is roster drift, not a rendering detail.
- **ADR-A7 — Standalone mode writes in place.** `outDir` there is the user's `.claude/`; a directory
  replace would delete their own agents and settings.
- **ADR-A8 — One hook, advisory, always exit 0.** Breaking a `pwtap:` marker region is this
  platform's own predicted failure mode (`MarkerError` and the paste-block path exist for it), and it
  is invisible until someone wonders why `add` did nothing. `${CLAUDE_PROJECT_DIR}` _is_ exported to
  hook processes, so this one works. No `settings.json` (a plugin granting `Bash` is a trust smell)
  and no monitors (nothing to watch).

## Risks

1. **`CLAUDE_PROJECT_DIR` availability here is unverified.** Gating leans on the registry and
   `PWTAP_PROJECT`. A ~30-minute spike settles it: register a throwaway local marketplace whose
   command dumps `env`, install it, read the file.
2. **The command string is frozen after acceptance.** Every future change costs users a re-accept and
   stops their background re-runs meanwhile.
3. **`npx -y` runs at every session start** — one registry roundtrip, a download on a cold cache.
   Skipped entirely under `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`; there is no fully offline `npx`,
   so air-gapped users take `init-agents`.
4. **Multi-project users can get the wrong roster** under the registry fallback. Named ceiling, with
   `/pwtap:vv-status` as the explanation and `PWTAP_PROJECT` as the fix.
5. **Roster drift** — prose naming a script or a doc the plugin no longer ships. Mitigated by
   `{{script:…}}` and `{{ref:…}}` resolution plus the smoke's stderr assertion; not fully solved,
   because prose can still go stale.

## Verification

```bash
npm run build && npm run lint && tsc --noEmit
npm test                    # includes 6 new files: frontmatter, requires, capabilities,
                            # defs, renderClaude, resolveProject, stdout
npm run smoke:agents        # render + gating both directions + idempotence + claude plugin validate
npm run nfr
```

`smoke-agents.mjs` asserts, against a real scaffold: the stdout contract; the layout; that nothing
mobile, db, perf or ai renders without its plugin; that hand-installing a resolvable
`@pwtap/plugin-appium` manifest makes `mobile-vv` and `mobile-locators` appear and nothing else;
that removing it takes them away; that two renders are byte-identical; that a project-less render is
still a loadable plugin; and — when the Claude CLI is on `PATH` — that both the plugin and the
marketplace manifest pass `claude plugin validate --strict`.

Manual, once per release:

```bash
claude --plugin-dir ~/.pwtap/claude-plugin/<slug>    # then /pwtap:vv-status
npx @pwtap/create add appium                          # new session → mobile-vv appears
npx @pwtap/create remove appium                       # new session → it is gone
```

## Named follow-up: an eval gate, blocked on early access

`claude plugin eval` is the right quality gate for this work and maps onto the repo's existing
culture exactly — a labelled case set, a threshold, a nightly job, the same shape as
`judge-calibration.yml`. Its `--ablation with-without` mode even measures the thing that matters: the
score delta between having the plugin and not having it.

It is **not built here** because the subcommand is gated:

```
$ claude plugin eval init --bare sample
`plugin eval` is currently in early access
```

The schema for `evals/**/case.yaml` and `graders/*.md` has no public documentation page either, so
authoring a suite now would mean guessing a format, shipping files nobody can run, and having no way
to verify them. When the feature opens up, the shape is already decided: `evals/` rendered into the
plugin directory, a nightly workflow modelled on `judge-calibration.yml` running
`claude plugin eval --json --no-publish --max-cost-usd <n> --threshold <t>`, and **not** wired into
the per-PR CI — it calls a model and spends money, exactly like the judge drift gate.

Until then the guard is `scripts/smoke-agents.mjs` plus `claude plugin validate --strict`, which
covers structure and gating but says nothing about whether the prose makes an agent behave better.
That gap is real and named rather than papered over.

## Not in this phase

The `agents-md` and `copilot` renderers; `workflows/*.js`; `.mcp.json` (Phase 3); monitors;
`settings.json`; per-project marketplace files; auto-rendering from `add`/`remove` (the command source
re-runs on its own, which is the entire reason it was chosen); Windows link mode; and generating
tests — the agents write tests, the renderer writes agents.
