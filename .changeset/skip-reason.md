---
'@pwtap/plugin-db': patch
'@pwtap/plugin-maestro': patch
'@pwtap/plugin-appium': patch
---

Say why a test was skipped in the terminal, not only in the report

A skipped test showed a dash and its name — no reason — so an unreachable database or an absent device looked
like an unexplained gap in the run. The reason was never missing: `testInfo.skip(condition, description)` records
it as a `skip` annotation, which the HTML and JSON reports read and **no terminal reporter prints**. The reason is
now printed beside the skip as well, and still recorded for the report.
