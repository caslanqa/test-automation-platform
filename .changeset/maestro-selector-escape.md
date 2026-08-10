---
'@pwtap/plugin-maestro': minor
---

Escape literal text before it becomes a Maestro selector

Maestro's `text` and `id` selectors are **regular expressions** — full-string, case-insensitive — and the
adapter passed `MobileLocator.text` and `.resourceId` straight into them. Both are literals by contract: the
visible text and the platform id of an element the recorder just hit-tested. So any ordinary label containing
regex syntax silently stopped matching the element it was recorded from — `Wi-Fi (2.4 GHz)`, `Storage [internal]`,
`Continue?`, `50% + tax` — and `$150 in Cash` was read as the start of a Maestro variable reference. The failure
mode was the worst kind: valid YAML, a valid pattern, and an element that "wasn't found".

Resource ids were wrong in the opposite direction: the dots in `com.example:id/login` are wildcards, so a
locator the engine had scored as unique was quietly matching more than it claimed.

`MobileLocator.native` is deliberately **not** escaped — it is the hand-authored escape hatch, and a caller
reaching for it is writing a Maestro selector on purpose, regex included.

**Behaviour change** for anyone who relied on a `text` locator being treated as a pattern: that now needs
`native`, e.g. `{ native: { text: '.*Continue.*' } }`.
