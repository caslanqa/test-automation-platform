---
name: ai-judge-rubrics
description: 'How to write a rubric an LLM judge can apply consistently, when to use a judge instead of a plain assertion, and how the judge is kept honest with calibration. Use when asserting on generated or free-form output.'
requires: plugin:ai-judge
---

An LLM judge is for output whose correctness is not a string comparison: a generated answer, a
summary, a rendered screenshot. It is a matcher, not a chat — deterministic where it can be, cached,
and calibrated against human labels.

## Use a plain assertion whenever one works

Reach for the judge only when a deterministic assertion genuinely cannot express the criterion:

| Criterion                                                       | Use                            |
| --------------------------------------------------------------- | ------------------------------ |
| exact text, a status, a field value                             | `expect` — always              |
| a value within a set or a pattern                               | `expect` with a regex or a set |
| "mentions the refund policy and does not invent a phone number" | a rubric                       |
| "the answer is supported by the retrieved context"              | grounded mode                  |
| "this screenshot still looks like the reference"                | image comparison               |

Every criterion you can move out of the rubric makes the remaining judgement cheaper and more stable.

## Writing a rubric

A rubric is a **checklist of independently checkable obligations**, not a paragraph of vibes. The
judge reports each criterion as met or unmet, the score is the share met, and a pass requires every
one to be met — so a holistic "seems fine" cannot override a specific failure.

- **One obligation per line.** "Polite and accurate and cites a source" is three criteria pretending
  to be one, and you cannot tell which failed.
- **Say what must be absent, not only what must be present.** "Does not invent a policy number" is
  usually the criterion that catches the real defect.
- **Make each line decidable from the output alone.** A criterion needing knowledge the judge does not
  have is a criterion it will guess at.
- **Keep it short.** A long rubric raises the routed model tier and lowers agreement between runs.
- **Never put the expected answer in the rubric** unless you mean an exact match — supply it as the
  reference instead, so the judge compares rather than pattern-matches.

## Grounded mode is the one to prefer for retrieval

If the question is "did the system make something up", grounded mode is stricter and cheaper than a
rubric: every claim must be supported by the supplied context, and unsupported claims are named. Use
it instead of writing "does not hallucinate" as a rubric line.

## The judged text is untrusted input

The system under test produced it, so it may contain instructions aimed at the judge. The plugin
already wraps all judged material in a nonced envelope and tells the model that everything inside is
data. Two consequences for you: **never** build a prompt by concatenating output into your own
instructions, and treat a suspiciously confident pass on adversarial content as a finding.

## Cost and determinism

Verdicts are cached on disk, keyed by the prompt version, the model, its revision, and the material —
so a re-run of an unchanged test costs nothing. Set `JUDGE_CACHE=off` when you are deliberately
measuring the judge rather than the system.

Every verdict is attached to the test with its per-criterion breakdown, the model, and the call count.
Read that attachment before disputing a verdict; it says which criterion failed and why.

## A judge you have not calibrated is a guess

Calibration runs the judge against human-labelled cases and reports accuracy plus Cohen's kappa,
with a gate on false passes. Kappa is the number that matters: accuracy alone is inflated by whichever
label dominates the dataset. The nightly workflow the plugin ships runs this with the cache off,
which is the only way a drift check can detect drift.

If you add a rubric that will gate a merge, add labelled cases for it too. A rubric nobody calibrated
is an assertion whose failure rate is unknown.
