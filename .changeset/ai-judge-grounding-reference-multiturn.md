---
'@pwtap/plugin-ai-judge': minor
---

AI Judge: check grounding, grade against a reference answer, and judge a turn inside its conversation

Three inputs, one of them a new matcher:

- **`context` + `toBeGroundedIn(context)`** — the hallucination check. Each factual claim the response
  makes becomes a criterion, met only when the sources state or imply it, so a claim that is true in the
  world but absent from the context fails and an omission never does. The failure names the unsupported
  claim (`Unsupported: The head office is in Istanbul`). Context is quoted to the judge as untrusted
  data, because in a RAG app it is exactly that.
- **`referenceAnswer`** — an answer that would satisfy the rubric, used as a reference for substance and
  never as text to match. Grading against a known-good answer is easier than grading in the abstract.
- **`conversation`** — the exchange leading up to the answer. The last assistant turn is the material
  when `botResponse` is omitted, and the earlier turns are what it is read against, which is what makes
  "contradicts what it said two turns ago" assertable at all.

The grounded prompt took two attempts and the failure is worth recording: the shared checklist wording
said criteria come "from what the criteria state", and with no rubric in grounded mode a 4B model read
the CONTEXT as the criteria source — it listed the context's facts as requirements and failed a faithful
response for not repeating them. The instruction that decides where checklist items come from is now
per-mode, and in grounded mode it says the criteria are the response's own claims and that a context fact
the response never claimed is not a criterion.

Even so, grounding asks more of a judge than the other modes, and the calibration set now says so out
loud: four cases were added (grounded faithful / invented policy / true-but-absent, plus a multi-turn
self-contradiction), and on them `qwen3.5:9b` scores 19/19 with kappa 1.00 while `qwen3.5:4b` drops to
17/19 — one false pass and one false fail, both grounded. That is the harness doing its job rather than a
promise in a README: run `judge:calibrate` before trusting a small model with a grounding assertion.
