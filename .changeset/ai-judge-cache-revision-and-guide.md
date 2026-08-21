---
'@pwtap/plugin-ai-judge': minor
---

AI Judge: a re-pulled model no longer replays stale verdicts, and every assertion states what it cost

Two fixes and a guide.

**The cache was keyed by the model's name.** `ollama pull qwen3.5:4b` replaces the weights behind an
unchanged tag, so every verdict judged by the old build would have replayed forever — a judge upgrade
would have changed nothing until someone deleted `.judge/`. Discovery now reads the digest Ollama already
reports and carries it as `ModelProfile.revision`, and the cache key includes it: re-pull a model and its
verdicts re-judge on the next run. Cloud models have no equivalent to read, so their keys are unchanged.

**An assertion never said what it cost.** `_meta.calls` and `_meta.latencyMs` now travel with the verdict
and the report attachment states `Cost: 3 calls, 12.6s` or `Cost: 0 calls (replayed from cache)`. Voted
verdicts sum both across their votes, and are marked cached only when every vote replayed. Measured:
cold 1 call / 5.9 s, replay 0 calls / 0 ms, `samples: 2` on an input already judged once → 1 new call.
No token-to-money conversion: that needs a price table that goes stale silently, so the report gives calls
and seconds and you multiply by the price you pay.

**`docs/AI_JUDGING.md`** collects what the last few changes established, in the order someone building a
suite needs it: write the rubric as requirements rather than a wish; pick the mode that matches the
question; assume the material is hostile because it is; measure the judge before trusting it; spend
sampling where a mistake is expensive; what the cache guarantees; how a model gets chosen; and what the
plugin deliberately does not do (no pixel comparison — Playwright's `toHaveScreenshot` already answers
that, exactly and faster — no threshold escalation, no judge fine-tuning). Every number in it came from a
run on this machine, including the ones that make the plugin look limited: `qwen3.5:4b` produces a false
pass and a false fail on grounded cases where `qwen3.5:9b` scores 19/19. It ships with the package and
`create-pwtap add ai-judge` copies it into the project.
