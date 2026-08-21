---
'@pwtap/plugin-ai-judge': minor
---

AI Judge: a panel votes concurrently, and a calibration run can be compared to last month's

**Votes now run concurrently.** A three-model cloud jury judged in sequence spends three round trips inside one
assertion's timeout, which is how a useful feature becomes one nobody switches on. Measured against a gateway that
sleeps a second per call: three votes took **1.0 s elapsed instead of 3.0 s**, with three requests in flight.
`Promise.all` keeps the ballot order, so the panel's report reads the same as before, and local votes still queue
behind the model gate that keeps a single Ollama model resident — a real `4b + 9b` jury completes without
contending for it. The report's `Cost:` line says "of judging" now, because summing concurrent calls gives time
spent, not time elapsed.

**`--json <out.json>`** writes the reports as data — dataset, timestamp, and every case's expected/actual/score —
alongside the human-readable output, and the nightly workflow uploads both. Text answers "did it pass tonight";
the JSON answers "which case started failing, and when", which is the question a drift check exists for. It is
written before the gates are applied, since the run that breached one is exactly the run worth comparing.

That flag came with a trap worth naming: its argument is a `.json` path too, and the CLI grades the last `.json`
it sees, so `--json report.json` would have graded the report file instead of the dataset. `pickDataset` takes the
flag-owned paths as exclusions and the smoke test asserts the combination — the same class of bug as the npm-script
default it already covered.
