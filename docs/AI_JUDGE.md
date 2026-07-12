# AI Judge System

The AI Judge system enables LLM-powered evaluation of chatbot/LLM responses against rubrics. Model
selection is **automatic and discovery-first**: the input's complexity picks a tier, and the tier
resolves to a concrete model discovered at runtime from whatever Ollama has installed — with the
9Router gateway (cloud) used only as a fallback when no compatible local model exists.

## Architecture

```
                         judgeResponse(input)
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │   analyzeComplexity     │  rubric length, criteria, response
                    │   → tier + needsVision  │  length, image, sensitive domain
                    └───────────┬─────────────┘
                                │  simple / medium / complex
                                ▼
                    ┌─────────────────────────┐     discovery (cached, parallel)
                    │      modelRouter        │◀──── Ollama /api/tags  (size + vision)
                    │  precedence:            │◀──── 9Router /models   (id + owner)
                    │  input.model            │
                    │  > input.tier           │     degradation ladder per tier:
                    │  > env JUDGE_MODEL       │       1. config pin (tierModels)
                    │  > auto (complexity)     │       2. dynamic local (by size)
                    └───────────┬─────────────┘       3. cloud fallback (discovered)
                                │
                 ┌──────────────┴──────────────┐
                 ▼                              ▼
        ┌──────────────────┐          ┌──────────────────┐
        │  ollamaProvider  │          │  openAIProvider  │
        │  Native /api/chat│          │ OpenAI-compatible│
        │  think: false    │          │ /chat/completions│
        │  No API key      │          │ Bearer API key   │
        └────────┬─────────┘          └────────┬─────────┘
                 ▼                              ▼
          Ollama (local)                9Router gateway (cloud)
```

Source layout: `utils/ai/{judge,providers,registry,router}/*` with routing policy in
`config/aiJudge.config.ts`. `utils/aiJudge.ts` remains as a thin re-export for backward
compatibility.

## Quick Start

### 1. Install Ollama

```bash
# macOS
brew install ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh

# Windows
# Download from https://ollama.com/download
```

### 2. Start Ollama and Pull Model

```bash
# Start Ollama server
ollama serve

# In another terminal, pull the default model
ollama pull qwen3.5

# Or use the helper script
./scripts/ci/judge-services.sh start local/qwen3.5
```

### 3. Configure Environment

Edit `env/environments.json`. No model is required — selection is automatic from the installed
Ollama models:

```json
{
  "common": {
    "JUDGE_OLLAMA_BASE_URL": "http://127.0.0.1:11434/v1",
    "JUDGE_OLLAMA_KEEP_ALIVE": "30m"
  }
}
```

Optional: set `JUDGE_MODEL` to pin one model globally (disables auto-routing); set `JUDGE_API_KEY` and `JUDGE_GATEWAY_BASE_URL` to enable the 9Router cloud fallback.

### 4. Write Your First AI Judge Test

```typescript
import { test, expect } from '@fixtures/globalFixtures';
import { judgeResponse } from '@utils/aiJudge';

test('chatbot provides accurate store hours', async ({ page }) => {
  // Get chatbot response (example)
  const botResponse = 'We are open Monday to Friday, 9am to 5pm.';

  // Judge the response
  const verdict = await judgeResponse({
    userMessage: 'What are your store hours?',
    botResponse: botResponse,
    rubric: 'Must state operating hours. Should mention days and times.',
  });

  expect(verdict.pass, verdict.reasoning).toBeTruthy();
  expect(verdict.score).toBeGreaterThan(70);
});
```

## API Reference

### `judgeResponse(input: JudgeInput): Promise<JudgeVerdict>`

Main function to judge a response.

#### JudgeInput

| Property         | Type                                | Required | Description                                                       |
| ---------------- | ----------------------------------- | -------- | ----------------------------------------------------------------- |
| `userMessage`    | `string`                            | No       | The user's question/message                                       |
| `botResponse`    | `string`                            | No       | The chatbot's response to evaluate                                |
| `rubric`         | `string`                            | No\*     | Evaluation criteria (rubric mode)                                 |
| `model`          | `string`                            | No       | Pin an exact model for this call (bypasses auto-routing)          |
| `tier`           | `'simple' \| 'medium' \| 'complex'` | No       | Force a tier (resolved to a concrete model)                       |
| `image`          | `string \| Buffer`                  | No       | Image to evaluate; the ACTUAL image in compare mode               |
| `referenceImage` | `string \| Buffer`                  | No\*     | EXPECTED reference image (compare mode); compared against `image` |
| `verbose`        | `boolean`                           | No       | Attach the routing trace to the verdict as `_meta`                |

\* Provide **either** `rubric` (rubric mode) **or** `referenceImage` (compare mode). Compare mode also requires `image` (the actual).

#### JudgeVerdict

| Property    | Type      | Description                                                                                                     |
| ----------- | --------- | --------------------------------------------------------------------------------------------------------------- |
| `pass`      | `boolean` | Whether the response satisfies the rubric                                                                       |
| `score`     | `number`  | Quality score 0-100                                                                                             |
| `reasoning` | `string`  | Explanation for the verdict                                                                                     |
| `_meta`     | `object?` | Routing trace (only when `verbose: true`): `selectedModel`, `tier`, `score`, `needsVision`, `reasons`, `source` |

### Automatic Model Selection

With no `model` or `tier`, the judge selects automatically:

1. **Complexity → tier.** `analyzeComplexity` scores the input from configurable signals (rubric
   length, number of strong criteria, response length, image present, sensitive domain) into
   `simple` / `medium` / `complex`.
2. **Tier → concrete model (degradation ladder).**
   - **Config pin** — `aiJudgeConfig.tierModels[tier]`, if set (local used only when installed).
   - **Dynamic local** — installed Ollama models ranked by parameter size: smallest for `simple`,
     largest for `complex`, median for `medium`. Vision-filtered when an image is judged.
   - **Cloud fallback** — only when no compatible local model exists: models discovered from the
     9Router `/models` endpoint, ordered by `cloudFallbackPrefer`, tried in turn (skipping any that
     return 401/403/404). A cloud model chosen this way logs a `(billable)` warning.
3. **Nothing usable** → an actionable error listing what was found locally and which cloud
   candidates were tried.

**Precedence:** `input.model` > `input.tier` > env `JUDGE_MODEL` > automatic. Naming a model
(`input.model` / `JUDGE_MODEL`) pins the judge for reproducible CI; a missing _local_ pin is a hard
error with a "did you mean…" suggestion rather than a silent substitution.

All calls use `temperature: 0`. Tune signals, tiers, vision hints, cloud preferences, and the
discovery cache TTL in `config/aiJudge.config.ts`.

## Model Options

You do not pick a model per call — the router discovers what is available and assigns it by tier
(see [Automatic Model Selection](#automatic-model-selection)). The tables below are just a guide to
typical models; substitute whatever you have pulled / whatever the gateway serves.

### Local Models (Ollama)

Any installed model works. Larger models map to higher tiers. Vision-capable models (reported by
Ollama's `/api/tags`) are required for image judging.

| Example model    | Approx. size | Typical tier |
| ---------------- | ------------ | ------------ |
| `qwen3.5:4b`     | ~4.7B        | simple       |
| `qwen3.5:latest` | ~9.7B        | medium       |
| `qwen3.6:35b`    | ~36B         | complex      |

### Cloud Models (9Router)

Discovered from the gateway's `/models` endpoint (ids + owner only — no pricing/capability data).
Used only as a fallback, or when explicitly pinned. Vision support is inferred from the id via
`visionHints`. Exact ids depend on your gateway, e.g. `gh/claude-sonnet-4.6`, `gh/gpt-5.4`,
`gh/gemini-3.1-pro-preview`.

## Configuration

### Environment Variables (`env/environments.json`)

Connection + credentials only — routing policy lives in `config/aiJudge.config.ts`.

| Variable                  | Default                     | Description                                                           |
| ------------------------- | --------------------------- | --------------------------------------------------------------------- |
| `JUDGE_MODEL`             | _(unset)_                   | Optional global pin — set to force one model and disable auto-routing |
| `JUDGE_OLLAMA_BASE_URL`   | `http://127.0.0.1:11434/v1` | Ollama API URL                                                        |
| `JUDGE_OLLAMA_KEEP_ALIVE` | `30m`                       | Model memory retention                                                |
| `JUDGE_GATEWAY_BASE_URL`  | -                           | 9Router gateway URL (enables cloud fallback)                          |
| `JUDGE_API_KEY`           | -                           | 9Router API key (enables cloud fallback)                              |

### Routing Policy (`config/aiJudge.config.ts`)

| Setting               | Purpose                                                     |
| --------------------- | ----------------------------------------------------------- |
| `tierModels`          | Optional per-tier model pins (leave `{}` for fully dynamic) |
| `complexity`          | Signal weights, length thresholds, and tier cutoffs         |
| `visionHints`         | Name substrings treated as vision-capable on the cloud side |
| `cloudFallbackPrefer` | Preferred cloud model name substrings, in order             |
| `registryCacheTtlMs`  | How long discovery results are cached                       |

### Per-Test Override

```typescript
// Pin an exact model (bypasses auto-routing):
await judgeResponse({ ...input, model: 'gh/claude-sonnet-4.6' });

// Force a tier (resolved to a concrete model via config/dynamic assignment):
await judgeResponse({ ...input, tier: 'complex' });

// Attach the routing trace for debugging:
const verdict = await judgeResponse({ ...input, verbose: true });
console.log(verdict._meta); // { selectedModel, tier, score, needsVision, reasons, source }
```

## Assertions with `expectAi`

`expectAi` extends Playwright's `expect` with AI-judge matchers (import from `@fixtures/aiExpect`,
or the `@fixtures` barrel). Every matcher accepts **either** a `JudgeInput` (judged on the spot)
**or** a `JudgeVerdict` (reused as-is, so several assertions on one verdict cost a single judge
call). Matchers are async — always `await`; `.not` and `expect.soft` work as usual.

```typescript
import { expectAi } from '@fixtures/aiExpect';
import { judgeResponse } from '@utils/aiJudge';

// Judge and assert in one call:
await expectAi({ userMessage, botResponse, rubric }).toPassRubric();
await expectAi({ userMessage, botResponse, rubric }).toPassRubric({ minScore: 80 });

// Negative case:
await expectAi({ userMessage, botResponse, rubric }).not.toPassRubric();

// Judge once, assert many — reuse one verdict across matchers (single judge call):
const verdict = await judgeResponse({ userMessage, botResponse, rubric });
await expectAi(verdict).toPassRubric();
await expectAi(verdict).toScoreAtLeast(80);
```

| Matcher                            | Asserts                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `toPassRubric(options?)`           | Verdict passes; `options.minScore` also requires score ≥ N               |
| `toScoreAtLeast(threshold, opts?)` | Verdict score ≥ `threshold`                                              |
| `toMatchImage(expected, options?)` | Received input's `image` matches the `expected` reference (compare mode) |

Every matcher's `options` accept `model` / `tier` to override routing per call (e.g.
`.toPassRubric({ model: 'gh/claude-sonnet-4.6' })`, `.toMatchImage(ref, { tier: 'complex' })`).
Overrides on an already-computed verdict throw (it was judged when the model was chosen).

On failure the message includes the judge's own `reasoning`. All `JudgeInput` fields apply in the
input form, e.g. `expectAi({ ...input, tier: 'complex', image }).toPassRubric()`.

### Reference-image comparison (compare mode)

Instead of describing the expected result in a `rubric`, provide an `expected` image and let the
judge compare the actual screenshot against it:

```typescript
const actual = await page.locator('#logo').screenshot();
await expectAi({ image: actual }).toMatchImage(expectedLogo);

// Optionally focus the comparison and force a stronger model:
await expectAi({
  image: actual,
  rubric: 'Ignore size; wordmark and colors must match.',
}).toMatchImage(expectedLogo, { tier: 'complex' });

// Or via the core function:
const verdict = await judgeResponse({ image: actual, referenceImage: expectedLogo });
```

> **Model note:** fine visual comparison is demanding — smaller local models can hallucinate
> differences. If auto-routing picks `medium` and results are unreliable, force `tier: 'complex'`
> (or a strong cloud model) for compare-mode assertions.

## Multimodal Judging

Judge images alongside text responses:

```typescript
test('visual response is correct', async ({ page }) => {
  // Take screenshot
  const screenshot = await page.screenshot();

  const verdict = await judgeResponse({
    userMessage: 'Show me the dashboard',
    botResponse: '', // No text, image only
    rubric: 'Dashboard should show a chart with sales data',
    image: screenshot, // Pass the screenshot buffer
  });

  expect(verdict.pass).toBeTruthy();
});
```

Supported image formats:

- `Buffer` (Playwright screenshot)
- Data URI (`data:image/png;base64,...`)
- File path (`./screenshots/test.png`)

## Table-Driven Tests

Use `ChatJudgeCase` for data-driven testing:

```typescript
import { ChatJudgeCase } from '@utils/types';

const cases: ChatJudgeCase[] = [
  {
    name: 'greeting',
    userMessage: '',
    rubric: 'Bot greets the user warmly',
    expectPass: true,
  },
  {
    name: 'store hours',
    userMessage: 'What time do you open?',
    rubric: 'States opening time is 9am',
    expectPass: true,
  },
  {
    name: 'wrong hours',
    userMessage: 'What time do you open?',
    rubric: 'States opening time is 8am',
    expectPass: false, // We expect this to fail
  },
];

for (const c of cases) {
  test(c.name, async ({ page }) => {
    // Get bot response for c.userMessage
    const botResponse = await getBotResponse(page, c.userMessage);

    const verdict = await judgeResponse({
      userMessage: c.userMessage,
      botResponse,
      rubric: c.rubric,
    });

    if (c.expectPass !== false) {
      expect(verdict.pass, verdict.reasoning).toBeTruthy();
    } else {
      expect(verdict.pass).toBeFalsy();
    }
  });
}
```

## Performance Tips

### 1. Warm Up the Model

```bash
# Before running tests
./scripts/ci/judge-services.sh warm local/qwen3.5
```

### 2. Set Keep-Alive

Keep the model in memory between tests:

```json
{
  "common": {
    "JUDGE_OLLAMA_KEEP_ALIVE": "30m"
  }
}
```

### 3. Steer Speed vs. Accuracy with Tiers

```typescript
// Fast smoke test — forces the smallest installed model
const verdict = await judgeResponse({
  ...input,
  tier: 'simple',
});

// Detailed regression test — forces the strongest available model
const verdict = await judgeResponse({
  ...input,
  tier: 'complex',
});
```

## CI/CD Integration

### GitHub Actions Setup

The workflow automatically:

1. Installs Ollama
2. Pulls the configured model
3. Warms up the model
4. Runs tests

```yaml
- name: Setup Ollama
  run: |
    curl -fsSL https://ollama.com/install.sh | sh
    ollama serve &
    sleep 5
    ollama pull qwen3.5
```

### Self-Hosted Runner

For faster CI, use a self-hosted runner with:

- GPU for faster inference
- Pre-pulled models
- Persistent Ollama service

## Troubleshooting

### Model Not Responding

```bash
# Check if Ollama is running
curl http://localhost:11434/api/tags

# Restart Ollama
./scripts/ci/judge-services.sh stop
./scripts/ci/judge-services.sh start
```

### Slow Response Times

1. Check VRAM usage (model should fit in GPU memory)
2. Use `think: false` (already configured)
3. Increase `keep_alive` to avoid model reloading
4. Consider smaller model for CI

### Invalid JSON Response

The judge expects JSON output. If the model returns malformed JSON:

1. Try a different model
2. Check the model version
3. Verify the system prompt is being applied

## Best Practices

1. **Write Clear Rubrics** - Be specific about what constitutes a pass
2. **Use Appropriate Models** - Smaller for speed, larger for accuracy
3. **Warm Up Models** - Prevents first-test latency
4. **Set Reasonable Scores** - Use score thresholds (e.g., >70) not just pass/fail
5. **Include Reasoning** - Log `verdict.reasoning` for debugging
6. **Test the Judge** - Verify your rubrics with known pass/fail cases
