---
'@pwtap/mobile-inspector': minor
---

Recording is now an explicit act, and the element menu can express what the IR always could

**Every click used to become a test step.** The viewport is also how you reach the screen you came to record,
so a recording began with the whole trip there, to be deleted by hand afterwards. A plain click now drives the
device and records nothing; **⌘/Ctrl + click records**. A `Record` toggle inverts the default — and is the
keyboard-reachable equivalent, since a modifier-click is mouse-only — and holding the modifier always means
"do the other thing, once". Choosing a locator from the context menu still records unconditionally: picking one
from a list is the explicit act. Navigation is now also cheaper than recording, because it skips codegen, the
draft update and the locator-strategy check entirely.

**The context menu offered five of the fifteen actions the IR has.** It now covers tap, fill, long press, wait,
assert visible / not visible, is visible, screenshot and an AI-rubric assertion, plus scrolling inside the
chosen element, "copy as code", "reveal in tree", and a checkbox to write a step down _without_ running it —
which was previously hard-wired for `assertNotVisible` alone and unavailable for anything else.

**`back` and `pressKey` had no way into a recording at all** — both are in the IR and supported by both drivers,
but neither the screen nor an element menu can express "press Home". A small toolbar under the viewport carries
Back / Home / Enter / Screenshot, under the same record gate.

**The element's own attributes are shown.** The ranked candidates say how to address an element; class, text,
accessibility id, resource id, owning package and bounds say whether it is the element you meant. They arrived
with every hit-test already and the UI dropped them.

**The editor completes from the device**: `mobileApp`'s methods, and locator literals built from the live
hierarchy. Reading an id off the tree panel and typing it back is exactly where a typo becomes a locator that
never matches.

**The timeline is walkable.** Each recorded step remembers the frame the screen showed once it had run, so
clicking a step shows that screen; a pinned step is read-only, because coordinates on a past screen do not
address the live one. Steps also carry a stable id now, which is what makes a step identifiable at all —
retracting a refused action had to match by object identity before. Retention is bounded at 50 step frames
(~7 MB) and a step whose frame has aged out says so instead of rendering blank.
