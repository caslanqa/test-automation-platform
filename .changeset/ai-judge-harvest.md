---
'@pwtap/plugin-ai-judge': minor
---

AI Judge: harvest the calibration dataset out of a normal test run

Calibration only says something about rubrics you actually assert, and hand-writing labelled cases is the
reason most teams never get past the shipped example. They already have the material: every AI assertion a
run judged is in `.judge/cache`. It was stored without the input, so nothing could be rebuilt from it —
the cache now records the material it judged (images excluded, since a buffer per entry would bloat it and
a harvested case without its screenshot cannot be re-judged), and:

```bash
npm test
npm run judge:calibrate -- --harvest tests/ai-judge/mine.json
```

drafts a dataset from it: the material, the judge's own label, its score and the requirements it marked
unmet, **least certain first** — a partly-met checklist ranks above anything near the middle of the scale,
which ranks above a flat 0 or 100. Repeat samples of one input collapse into one case, entries with an
image or without recorded material are skipped with a count, and the order is stable across machines
rather than following `readdir`.

The drafted labels are the judge's, and the file says so in a `_note`: calibrating it unreviewed scores
100 % and proves only that the judge agrees with itself. Verified end to end on five real judgements — five
drafted cases, 100 % before review, and flipping one label by hand surfaced exactly the row a reviewer
wants to see: `FALSE FAIL … judged 50/100: the response omits the Sunday closure`.

Cases are named after the answer under test rather than the rubric: several cases usually share one rubric,
and the first draft produced a file of four identically-labelled rows.

Two defects the live run found, both invisible to the tests that existed: `npm run judge:calibrate -- mine.json`
graded the **default** dataset, because the npm script carries its own path as the first positional and the
CLI took the first `.json` it saw — the last one wins now, and `pickDataset` is unit tested for exactly that
argv shape. And the drafted order followed `readdir` whenever two verdicts were equally certain, so the file
churned between machines; ties break on the material instead.
