---
'@pwtap/plugin-maestro': patch
---

Fix the Maestro binary resolving to an empty string when the injected `MAESTRO_BIN` env key is left blank. The code used `process.env.MAESTRO_BIN ?? 'maestro'`, but `??` doesn't fall back on `''`, so runs spawned an empty command (`spawn '' EACCES` / "file cannot be empty"). Use `|| 'maestro'` so a blank value falls back to the `maestro` binary on PATH.
