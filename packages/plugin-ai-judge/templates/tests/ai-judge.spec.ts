import { expect, test } from '@fixtures';

/**
 * AI Judge example — LLM-as-judge matchers on `expect`.
 *
 * Requires a judge model: set `JUDGE_MODEL` in env/environments.json (plus credentials). Examples:
 *   - local/llama3.1                      (local Ollama)
 *   - gpt-4o + JUDGE_GATEWAY_BASE_URL/API_KEY   (OpenAI / OpenRouter / NVIDIA / any OpenAI-compatible)
 *   - anthropic/claude-opus-4-8 + ANTHROPIC_API_KEY   (native Claude)
 *
 * Skips when no model is configured, so it never fails a fresh scaffold.
 */
test.describe('AI Judge', () => {
  test.skip(
    !process.env.JUDGE_MODEL && !process.env.JUDGE_GATEWAY_BASE_URL,
    'Set JUDGE_MODEL (and credentials) in env/environments.json to run AI-judged assertions.',
  );

  test('a correct answer passes its rubric', async () => {
    await expect({
      userMessage: 'What is the capital of France?',
      botResponse: 'The capital of France is Paris.',
      rubric: 'The response correctly identifies Paris as the capital of France.',
    }).toPassRubric({ minScore: 70 });
  });

  test('a wrong answer fails its rubric', async () => {
    await expect({
      userMessage: 'What is the capital of France?',
      botResponse: 'The capital of France is Berlin.',
      rubric: 'The response correctly identifies Paris as the capital of France.',
    }).not.toPassRubric();
  });
});
