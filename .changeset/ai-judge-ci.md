---
'@pwtap/plugin-ai-judge': minor
---

AI Judge: a nightly drift gate you do not have to write, and CI coverage for the calibration path itself

**Shipped to the project:** `create-pwtap add ai-judge` now drops `.github/workflows/judge-calibration.yml`. It
re-judges the labelled dataset nightly and fails when agreement with your labels drops — the check that turns
"we calibrated once" into "the judge is still the judge". Four decisions inside it are the point:

- **Nightly, not per pull request** — judging costs money and drift takes days, not commits.
- **`JUDGE_CACHE=off`** — a drift check that replays yesterday's verdicts reports that nothing changed, which is the
  one answer it must never be able to produce.
- **`MAX_FALSE_PASS: 0` is the real gate**, with accuracy and kappa as looser floors. Measured on the shipped set:
  `qwen3.5:4b` scored 89 % on one uncached run and 95 % on the next, the miss landing on a different case, while
  false passes stayed 0 both times. Gating tightly on accuracy would page someone about the judge's own noise.
- **No dataset path is hardcoded.** The `judge:calibrate` script already names it, and that path is rewritten for a
  project scaffolded with `--tests-dir` — verified on an `e2e/` project, where the workflow grades
  `e2e/ai-judge/calibration.json` without knowing the folder was renamed.

It skips with a `::notice::` until a `JUDGE_MODEL` repository variable and the matching API-key secret exist, because
`env/environments.json` is gitignored and never reaches a runner, and a fork should not see a red nightly badge.
Both branches of that step were run locally, as was the calibrate step itself against a local model (95 %, exit 0,
61-line report uploaded as an artifact and summarised on the run page).

**Covered in this repo's own CI:** `npm run smoke:judge`. The calibration path is shipped tooling — a CLI, a
labelled dataset, agreement metrics, the exit codes CI gates on — and nothing in CI can reach a model: no Ollama on
a runner, no key in this repo. A local fake gateway answers as an OpenAI-compatible endpoint and returns, per case,
whatever verdict the script decides, which is the only way to assert that a gate FIRES: it flips one verdict and
requires exit 1 naming that case. It also checks every shipped case actually reaches the judge (a case the fake
gateway cannot identify is a case no one is grading), that `--harvest` round-trips, and that a dataset named after
the npm script's own path wins.

Writing it found the mistake worth recording: the first version used `spawnSync`, which blocks the event loop of
the very process hosting the fake gateway, so every request timed out at the full three-minute deadline.
