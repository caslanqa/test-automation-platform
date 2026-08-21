---
'@pwtap/plugin-ai-judge': minor
---

AI Judge: sample the judge, or seat a panel, and let a tie fail

A judge on the borderline of a rubric answers differently on different runs — measured here on the same
input, same model, three uncached calls: 67, 50, 50. `samples: n` judges the material n times, `jury:
[...]` judges it with each model listed, and both take a **strict majority**, so a tie fails: judges
disagreeing is not evidence the material is right. The score is the median of the votes (one outlier
cannot drag it), the reasoning and checklist are kept from a voter on the winning side, and the split is
stated in the reasoning and in the report — `Votes: 2/3 agreed on fail`, with `_meta.votes` /
`_meta.agreement` for anything that wants the numbers.

Both work through `expect` (`toPassRubric({ samples: 3 })`, `toPassRubric({ jury: [...] })`), through
`judgeResponse`, and in the calibrator (`--samples`, `--jury`) — which is the point: whether voting buys
anything is a measurement, not a belief. Each sample is cached under its own key, so a re-run of a voted
assertion replays every vote (measured: 12.6 s cold, 1 ms replayed) and a sample-0 key is byte-identical
to what a single-sample call already wrote.

What the measurement says on this machine: with the checklist scoring in place, `qwen3.5:4b` scored 15/15
on the scaffolded dataset single-sample, with `--samples 3`, and with a `4b + 9b` jury alike. Sampling
did not buy accuracy here — it bought a stable score on the one case whose score wandered, and it is the
tool that tells you which of those two situations you are in. A local jury pays a model swap per vote,
so prefer it where a mistake is expensive rather than everywhere.

Not included: escalating automatically when a verdict lands near `minScore`. It needs a threshold, a
policy and a config knob to save calls a caller can already choose to spend, and nothing measured here
justified it yet.
