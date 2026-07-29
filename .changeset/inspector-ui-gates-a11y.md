---
'@pwtap/mobile-inspector': minor
---

Make the save dialog browse the project, gate refused actions, and fix the UI's accessibility holes.

The save dialog asked for a location as free text, so a typo became "cannot read tests" at save time. It now
lists the project's real directories (`listDirs`), skipping `node_modules`, build output and dotfiles, with
drill-in and a parent link. Both save and browse resolve through one confinement helper that compares path
segments and follows symlinks — the previous `startsWith` check let `/proj-evil` pass as inside `/proj`, and
a symlinked directory read or wrote outside the project (ADR-010).

The locator menu no longer offers actions the connected driver refuses: each button is disabled with the
driver's own reason as its tooltip. Only an explicit `false` in the driver's capabilities refuses, so a
driver that has not listed a kind is not crippled.

**Accessibility:** the connection drawer was `aria-hidden` while closed, which hid it from screen readers but
left every control tabbable; it is now `inert`, closes on Escape, and moves focus in on open. The locator
menu is a labelled dialog whose candidates are a radiogroup with arrow/Home/End navigation, a roving tab
stop, focus moved in on open and restored on close. The save dialog is a native `<dialog>` opened with
`showModal()`, which supplies the focus trap, Escape and focus restoration it previously lacked.
