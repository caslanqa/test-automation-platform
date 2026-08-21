---
name: vv-status
description: 'Show which pwtap V&V agents and skills are live in this project, and why — the detected project, its capability tokens, and what each one gated.'
requires: core
---

Report the state of the pwtap agent roster.

1. Read `{{rosterReport}}`. The renderer wrote it, and it records which project was
   detected, which capability tokens that produced, and which agents and skills each token gated in
   or out. Show the user that table — do not paraphrase it.

2. Confirm the detected project is the one they are working in. The roster is rendered by a command
   that Claude Code runs **from the user's home directory**, so it cannot see the session's working
   directory; it resolves the project from `--project`, then `PWTAP_PROJECT`, then
   `CLAUDE_PROJECT_DIR`, then the project registry at `~/.pwtap/projects.json`. If the README names a
   different project than the one they are in, that is the whole explanation for a wrong roster.

   The fix, in order of directness:

   ```
   export PWTAP_PROJECT=/path/to/this/project   # then restart the session
   npx @pwtap/create add <plugin>                # also re-registers this project
   ```

3. If a capability they expected is missing, check it for real rather than trusting the README, which
   was written when the command last ran:

   ```
   ls node_modules/@pwtap                       # what is actually installed
   grep -n "pwtap:plugins:projects" -A5 playwright.config.ts
   ```

   A plugin listed in `package.json` but absent from `node_modules` is not installed — the roster
   deliberately requires resolution, not a declaration, because agents for a half-installed plugin
   would hand the model scripts that do not run.

4. To pick up a change now rather than next session, run `/reload-plugins`. The renderer re-runs once
   per session in the background, so installing or removing a pwtap plugin shows up on the next
   session without any action.
