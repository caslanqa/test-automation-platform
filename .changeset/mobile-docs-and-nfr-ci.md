---
'@pwtap/mobile-core': patch
'@pwtap/mobile-inspector': patch
---

Add the missing READMEs, and enforce the dependency budget in CI.

Neither `@pwtap/mobile-core` nor `@pwtap/mobile-inspector` had a README — the two newest packages in the
workspace were the two with no published documentation.

`npm run nfr` now checks the §11 budget rows that are deterministic: no `electron` anywhere in the runtime
packages' transitive graph, no `ws`/`prettier`/`typescript` as our own direct dependency (a third-party
client bringing its own WebSocket implementation is its business), the inspector's published artifacts all
present, and its unpacked size within 5 MB. CI also builds the inspector's UI bundle now, which nothing did
before — a vite failure would have surfaced at publish time.

A device-gated workflow (`device.yml`, nightly plus manual dispatch) runs the record → generate → save flow
across Android × {Maestro, Appium} and iOS × {Maestro, Appium}, with a 10-minute per-test timeout because
the 30 s default is sized for the fake driver.
