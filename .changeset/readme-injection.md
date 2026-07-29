---
'@pwtap/create': minor
---

Put each plugin's usage notes into the project's README, and derive the plugin list instead of typing it out.

Every plugin manifest already declared a `readmeSection` — `ai-judge` wrote a substantial one — and nothing read
the field. A scaffolded project had no README at all, so the first place a teammate looks to learn what the suite
can do was empty while four plugins carried the answer. Found by auditing which parts of `plugin-db` were
declared but never watched run: `ensure` fired correctly, the docs copied, and this did nothing.

`create-pwtap add` now creates a README when a project has none and gives each plugin its own marked section, so
adding twice refreshes rather than duplicates and `remove` takes out exactly its own. Markers are HTML comments,
since a `//` line is body text in Markdown.

The "Add a plugin later" hint after scaffolding is derived from the registry too. It read
`<maestro|appium|ai-judge>` — hardcoded, so it silently omitted `db` the day it shipped, and would have omitted
the next plugin as well.
