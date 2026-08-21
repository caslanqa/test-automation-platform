---
'@pwtap/create': minor
---

Agentic V&V: a Claude Code plugin that is rendered from the test plugins your project actually has

Claude Code has **no conditional component loading** — a plugin is enabled or disabled whole — so an
agent pack that ships mobile agents ships them to everyone, including projects with no mobile plugin.
That is the problem this solves, and it can only be solved on our side.

**`create-pwtap claude-plugin-path`** reads a project's installed pwtap plugins and renders only the
agents, skills and commands those support, then prints the directory's absolute path. A marketplace
entry with a `command` source runs it — Claude Code re-runs it once per session in the background and
hot-reloads on changed content, so `create-pwtap add appium` makes `mobile-vv` and `mobile-locators`
appear on the next session, and `remove` makes them disappear. No install step, no sync command.

The roster: eight agents (`vv-lead`, `story-reviewer`, `test-strategist`, `test-author`,
`suite-reviewer`, `run-triage`, plus `release-gate` and `mobile-vv` when the project qualifies), nine
skills, and `/pwtap:vv` + `/pwtap:vv-status`. A core-only project sees six agents and four skills.
Installation is decided by **resolution, not by `devDependencies`**: a plugin listed but not yet
installed would hand the model scripts that do not run, so its agents stay out and the render says so.

**The hard part was finding the project.** A marketplace command runs from the user's home directory,
and the documented recipients of `CLAUDE_PROJECT_DIR` are hook, MCP and LSP subprocesses — not this.
The command string is also frozen once a user accepts it, so it cannot be passed as an argument later
either. Resolution is therefore a chain: `--project`, then `PWTAP_PROJECT`, then `CLAUDE_PROJECT_DIR`
read opportunistically, then a project registry at `~/.pwtap/projects.json` that `create`, `add` and
`remove` write. With nothing resolvable it renders a core-only baseline and exits 0 — a missing
project must never fail a session start. `/pwtap:vv-status` exists to make a wrong roster explainable.

The renderer's contract is one line of stdout and nothing else, which is why `log.info` is banned on
that path — it is `console.info`, and one stray call would break every user's install silently.
Measured with a cold npm cache: `npx -y` writes nothing to stdout, so the published command string
needs no `| tail -n 1`.

Definitions live in `packages/create/agents/` as model-neutral markdown with a `requires` predicate
(`core`, `plugin:<id>`, `cap:<name>`; `|` for OR, `,` for AND, `!` to negate) and a neutral tool
vocabulary. Only the Claude renderer is implemented; the `targets` field and that vocabulary exist so
`AGENTS.md` and Copilot are a renderer each rather than a format migration.

**Fallback for anyone the plugin cannot reach** — Claude Code older than 2.1.229, an organisation
blocking command plugin sources, or a machine offline at session start:
`npx @pwtap/create init-agents --loop=claude` writes the same components into `<project>/.claude/`,
un-namespaced, without touching anything already there. It is a static snapshot; re-run it after
`add` or `remove`.

Also: `.github/copilot-instructions.md` is no longer wrong. It documented four marker names that never
existed in the code, said the platform had no tests (there are 61 test files), listed four of ten
packages, and put `core-template` in a `tsc -b` graph the root `tsconfig.json` deliberately omits.
