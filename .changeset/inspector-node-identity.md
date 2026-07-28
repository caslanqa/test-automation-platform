---
'@pwtap/mobile-core': minor
'@pwtap/mobile-inspector': minor
'@pwtap/plugin-maestro': minor
'@pwtap/plugin-appium': patch
---

Three recording fixes, each verified against a real emulator.

**Tree selection survives a hierarchy read.** Every read builds a fresh object graph, and the accessibility
tree compared nodes with `===`, so a selected element silently deselected itself on the next poll while the
device panel kept highlighting stale bounds. Nodes now carry `path` and `key` (`assignNodeIdentity`), and the
UI remembers the key and re-resolves it each render.

**Maestro honours a recorded scroll direction.** The adapter called Maestro's bare `scroll()`, which only
ever scrolls down, so the direction the user recorded was discarded; it now issues a directional swipe.
`scroll` with `within` is refused with a clear message rather than silently scrolling the whole screen and
producing a test that merely looks like it scrolls a container.

**A locator from another app is flagged, not ranked highly.** A whole-screen hierarchy includes other apps'
elements, and tapping one can succeed while the replay fails, because a driver is scoped to an app id. Such
a node now loses 60 points and carries an explicit warning. Detection is partial by platform: Appium Android
reports the owning package per node, while Maestro's payload has no package field at all — see §7 of
`docs/mobile-inspector/architecture.md`.

**Also:** the Maestro adapter was dropping `cls`, `enabled` and `val` from every node, which left the whole
hierarchy unlabelled in the tree (91 nodes on a real screen, 0 with a class name) and weakened the new
identity key. `val` now folds into `text`, matching how the Appium adapter already folds iOS `value`.
