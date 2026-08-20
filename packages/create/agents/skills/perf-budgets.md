---
name: perf-budgets
description: 'How to set a performance budget that fails for a real reason, and where in-suite budgets end and k6 load testing begins. Use when adding a perf assertion, reviewing one, or interpreting a perf failure.'
requires: plugin:perf
---

Two layers, and confusing them is the usual mistake.

| Layer                                                                     | Runs                                                                   | Answers                                                |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------ |
| **In-suite budgets** — Core Web Vitals, resource totals, endpoint latency | inside the Playwright suite, via the perf fixture                      | "did this change make the page or the endpoint worse?" |
| **k6 load scenarios** — smoke, load, stress, spike, soak                  | outside Playwright, via the `perf:*` scripts against `PERF_TARGET_URL` | "what happens under N concurrent users?"               |

An in-suite budget is a **regression gate**: one browser, one run, a threshold. A load scenario is a
**capacity measurement**: it needs a target that resembles production and it does not belong in the
per-PR suite. Putting a load test in the suite makes every PR slow and every result noisy; putting a
vitals check only in a load run means nobody notices a regression until it is released.

## Setting a budget that means something

- **Measure before you assert.** Run it several times and look at the spread. A budget set from one
  sample fails on the second run for no reason, and the team learns to ignore it.
- **Set it above the observed spread, not at the observed value.** A threshold at the current p50 fails
  half the time by construction.
- **Use a percentile for latency, not a mean.** A mean hides the tail, which is the part users feel.
- **Budget what the user experiences.** Total transferred bytes and the vitals are behavioural; a
  count of requests usually is not.
- **A local budget is not a CI budget.** CI is slower and more variable. Either set the threshold for
  the slower environment or gate the assertion to one of them — but say which, in the test.

## Reading a perf failure

Rank these before touching the threshold:

1. **The environment.** A shared runner under load reports a regression that does not exist. Check
   whether other timings in the same run also moved; if everything is slower, nothing regressed.
2. **A real regression.** Something in the change added bytes, requests, or blocking work. This is the
   case the budget exists for.
3. **The budget was always wrong.** It was set from one sample and has been failing intermittently
   since. Fix the budget, and say that is what you are doing.

Never raise a threshold to make a run green without deciding which of these it was. A budget quietly
raised each time it fails is a budget that measures nothing.

## k6 needs a binary

The k6 scenarios need the k6 CLI installed on the host — the plugin prints the platform-correct
install command and installs nothing itself. So a k6 scenario that "did not run" is usually a missing
binary, not a failure.
