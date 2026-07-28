---
'@pwtap/mobile-inspector': minor
---

Split the recording engine into focused modules, and fix undo/redo quietly losing work.

The engine had grown to 967 lines owning the device, the action log, the source draft, file writing and the
Playwright child process at once. Four responsibilities now have their own modules — `TestRunner`,
`TestWriter`, `Recorder`, `Draft` — leaving the coordinator at 656 lines. Behaviour is unchanged except where
noted; the existing end-to-end tests through the engine are what made the extraction safe.

**Undo/redo no longer discards work.** The action log was a pair of stacks, and any non-append edit threw the
redo stack away: undoing a step and then removing an unrelated one made the undone work unrecoverable with no
indication. It is now a cursor over an append-only log, so undo destroys nothing, and a removal that does
rewrite the log is deliberate and observable.

**The draft's writer is explicit.** It is either generated from the action log or owned by the user once they
type, and a device event is never the writer — which is the rule that keeps pressing Run from emptying the
editor, since `run` releases the device before it spawns Playwright.
