---
'@pwtap/mobile-inspector': patch
---

A recorded drag carries how far the finger travelled.

§9 required it and the UI never did: every drag collapsed into a direction-only full-screen swipe, so a short
flick and a long pull recorded identically and the generated test scrolled a different amount than the user
had. It sends the measured fraction of the swept axis now — possible only because `SwipeOptions.distance`, dead
in both adapters until the adapter audit, is honoured.

The start point is still not carried, and §9 says so rather than claiming the item closed: a swipe beginning
near the top edge can mean something different from one beginning mid-screen.
