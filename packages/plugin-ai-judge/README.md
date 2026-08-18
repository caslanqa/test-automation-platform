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
