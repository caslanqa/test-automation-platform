---
'@pwtap/plugin-ai-judge': minor
---

AI Judge: measure the judge against human labels, and prefer a model built to judge

Every AI assertion in a suite rests on a judge nobody validated. `npm run judge:calibrate` grades
`tests/ai-judge/calibration.json` — labelled examples where `expected` is the verdict a **human** gives
— and reports accuracy, Cohen's kappa, and the number that decides whether a suite can be trusted:
**false passes**, cases the judge passed that a human failed. Repeat `--model` to compare candidates in
one run, gate CI with `--min-accuracy` / `--min-kappa` / `--max-false-pass` (non-zero exit), and
`--no-cache` to re-judge rather than replay (measured on two cases: 70 ms replayed, 7.9 s re-judged).
`calibrate()`, `kappa()` and `loadDataset()` are exported for a test that wants the numbers inline.

The report is headed by the model that **actually** judged, read off the routing trace — an env
`JUDGE_MODEL` decides the model without appearing in the options, and a report headed `auto` hides the
one thing it exists to state.

A scaffold ships 15 cases covering the failure modes worth watching — a padded but correct answer, a
long confident wrong one, a polite non-answer, a refusal that should hold and one that leaks, a response
instructing the judge to pass it, agreement with the user's wrong premise, self-contradiction. Replace
them: numbers only mean something about rubrics you actually assert. On this machine `qwen3.5:4b` scored
15/15 in one project and 14/15 in another, both fresh caches, differing on the self-contradiction case
— a single-sample judge is unstable on borderline material, which is what the harness is for and what
sampling-based agreement will address next.

Also: when any installed Ollama model matches `judgeModelHints` in `aiJudge.config.ts` (`selene`,
`prometheus`, `glider`, `flow-judge`, …), the router picks tiers from those alone, and the existing size
buckets apply among them. An 8B judge-tuned model out-grades a much larger generalist; ranking local
models by parameter size alone left it unused. With none installed, selection is unchanged.
