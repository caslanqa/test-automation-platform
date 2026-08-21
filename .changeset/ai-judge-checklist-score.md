---
'@pwtap/plugin-ai-judge': minor
---

AI Judge: the score is a checklist the judge answered, not a number it picked

Asking a model "how good is this out of 100" asks for a resolution it does not have: on a local
`qwen3.5:4b`, every verdict came back 0 or 100, and a CI gate of `minScore: 80` sat on top of that.
The judge now splits the rubric into atomic requirements (at most 8, taken only from what the rubric
states), answers each one yes/no with a clause of evidence, and the score is the share it met. Same
model, same four responses to a three-requirement rubric: **100 / 67 / 33 / 0**, and five uncached runs
of the partial case returned 67 every time.

Two consequences worth knowing before upgrading:

- **A verdict needs every requirement met to pass.** A holistic "pass" over an unmet requirement is
  the judge contradicting itself, and in a test suite that has to fail — so a rubric with a requirement
  nobody noticed was being graded loosely will now fail. `minScore` is the knob for partial credit.
- **Requirements count equally.** The first cut asked the judge to weight them 1-3, and it gave the
  same rubric `3,3,3` on one run and `1,1,2` on the next — the score moved without anyone learning
  anything. Weights belong to whoever wrote the rubric, not to the judge, so they are gone.

The checklist rides along in the verdict (`criteria: [{ criterion, met, why }]`), is cached with it, and
lands in both places a failure gets read: the assertion error names the unmet requirements, and the
report attachment lists every requirement with ✓/✗ and the evidence. A rubric with nothing separable
(or an image comparison with no criteria) still returns an empty checklist and the model's own score.
