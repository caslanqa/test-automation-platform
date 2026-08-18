# @pwtap/plugin-ai-judge

LLM-as-judge matchers for the [Playwright Test Automation Platform](https://www.npmjs.com/package/@pwtap/create) — assert that a chatbot/LLM output meets a rubric, straight from `expect`.

[![npm](https://img.shields.io/npm/v/@pwtap/plugin-ai-judge)](https://www.npmjs.com/package/@pwtap/plugin-ai-judge)

## Install

Into a `@pwtap` project (recommended — wires `expect`, env keys, and an example spec):

```bash
npx create-pwtap add ai-judge
```

## Matchers

```ts
import { test, expect } from '@fixtures';

test('bot states the opening hours', async () => {
  await expect({
    userMessage: 'What time do you open?',
    botResponse: 'We open at 9am every day.',
    rubric: 'Must state the store opens at 9am.',
  }).toPassRubric({ minScore: 80 });
});
```

- `toPassRubric({ minScore })` — pass/fail against a rubric with a 0–100 score.
- `toScoreAtLeast(n)` — score threshold only.
- `toMatchImage(rubric)` — judge a screenshot against a visual rubric.

## The score is a checklist, not an opinion

The judge splits the rubric into atomic requirements, answers each yes/no with its evidence, and the score is the share it met — so a partial answer lands on 67 rather than on whatever number a model picks for "pretty good", and the failure names the requirement that failed. Every requirement must be met to pass; `minScore` is there for partial credit. Requirements count equally on purpose: asked to weight them, a model weights the same rubric differently on the next run.

```text
Error: expect(received).toPassRubric(expected)
Received: fail (score 67)
Unmet: mention the store is closed on Sunday
  ✓ state the store opens at 9am — The text explicitly states 'We open at 9am'
  ✓ state it closes at 6pm — The text explicitly states 'and close at 6pm'
  ✗ mention the store is closed on Sunday — The text does not mention Sunday
```

## Pick a model — `JUDGE_MODEL` (+ its key) in `env/environments.json` → `common`

The model id's **prefix** routes it to a provider:

| Prefix        | Provider                       | Example `JUDGE_MODEL`                               | Key                                        |
| ------------- | ------------------------------ | --------------------------------------------------- | ------------------------------------------ |
| `anthropic/`  | Native Claude                  | `anthropic/claude-opus-4-8`                         | `ANTHROPIC_API_KEY`                        |
| `openrouter/` | OpenRouter                     | `openrouter/meta-llama/llama-3.3-70b-instruct:free` | `OPENROUTER_API_KEY`                       |
| `nvidia/`     | NVIDIA                         | `nvidia/meta/llama-3.3-70b-instruct`                | `NVIDIA_API_KEY`                           |
| `openai/`     | OpenAI                         | `openai/gpt-4o`                                     | `OPENAI_API_KEY`                           |
| `groq/`       | Groq                           | `groq/llama-3.3-70b-versatile`                      | `GROQ_API_KEY`                             |
| `local/`      | Ollama                         | `local/llama3.1`                                    | — (Ollama running)                         |
| _(none)_      | Any OpenAI-compatible endpoint | `my-model`                                          | `JUDGE_GATEWAY_BASE_URL` + `JUDGE_API_KEY` |

`anthropic/` is **native** (your own Anthropic key). To reach Claude _through_ OpenRouter instead, use `openrouter/anthropic/claude-3.5-sonnet` — the prefixes don't collide.

## When one judgement is not enough — `samples` and `jury`

A judge that sits on the borderline of a rubric answers differently on different runs. `samples: n` judges the same material n times; `jury: [...]` judges it with each model listed — a panel of smaller models agrees with humans better than one large judge and cannot share a single model's bias. Both take a **strict majority**, so a tie fails: judges disagreeing is not evidence the material is right. The score is the median of the votes, the split lands in the report (`Votes: 2/3 agreed on fail`), and each sample is cached separately, so the cost is paid once.

```ts
await expect(input).toPassRubric({ samples: 3 });
await expect(input).toPassRubric({ jury: ['local/qwen3.5:4b', 'anthropic/claude-opus-4-8'] });
```

## Measure the judge — `npm run judge:calibrate`

A judge nobody measured is a test nobody validated. Put your own labelled examples in `tests/ai-judge/calibration.json` (`expected` is the verdict a **human** gives), and the command grades them with one or more models and reports accuracy, Cohen's kappa and — the number that matters in a suite — how many cases the judge **passed that a human failed**. Compare candidates in one run with repeated `--model` (or measure what voting buys with `--samples` / `--jury`), and gate CI with `--min-accuracy` / `--min-kappa` / `--max-false-pass` (non-zero exit when a gate fails). Verdicts come from the same cache as a test run, so re-running an unchanged dataset is free.

```bash
npm run judge:calibrate -- --model local/qwen3.5:4b --model anthropic/claude-opus-4-8 --max-false-pass 0
# local/qwen3.5:4b: 93% accuracy (14/15), kappa 0.86, false pass 1, false fail 0
#   FALSE PASS  contradicts itself — judged 100/100: …
```

## Judge with a model built to judge

When any installed Ollama model matches `judgeModelHints` in `config/aiJudge.config.ts` (`selene`, `prometheus`, `glider`, `flow-judge`, …), the router picks tiers from those alone — an 8B judge-tuned model out-grades a much larger generalist, and ranking local models by size alone left it unused. `ollama pull` one and it takes over; with none installed, nothing changes.

## Determinism, cost and safety

Every verdict is cached under `.judge/cache`, keyed by model + material, so a re-run replays the same judgement for free — `JUDGE_CACHE=off` re-judges from scratch. A single request is bounded by `JUDGE_TIMEOUT_MS` (default `180000`), and rate limits (429) and 5xx are retried with backoff instead of failing the test. The response under test is quoted to the judge as data inside a per-call `<material-…>` tag, so a bot reply that instructs the judge to pass gets graded, not obeyed. The judge is asked for its reasoning **before** the score, and constrained to the verdict schema where the backend supports it (Ollama `format`, OpenAI-compatible `response_format`).

```ts
// Compare mode: judge both image orders and fail a verdict that flips when they swap.
await expect({ image: shot }).toMatchImage(golden, { strict: true });
```

## Bring your own provider

```ts
import { registerProvider } from '@pwtap/plugin-ai-judge';

registerProvider('gemini', new GeminiProvider(), { prefix: 'gemini/' });
// then: JUDGE_MODEL=gemini/gemini-2.0-flash
```

## Requirements

- Peer: `@playwright/test >= 1.61`. Node ≥ 22.23.
- A reachable provider at run time; the example spec **skips** when `JUDGE_MODEL` is unset, so core tests are unaffected.

## License

MIT
