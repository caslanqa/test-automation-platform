/**
 * @pwtap/create injection manifest for the AI Judge plugin. Matcher-only — no test fixture and no
 * Playwright project; it merges `expect` matchers via mergeExpects and adds the JUDGE_* env keys the
 * engine reads. Provider selection is env-driven via `JUDGE_MODEL`: a local Ollama model (`local/…`),
 * a bare id for any OpenAI-compatible endpoint (`JUDGE_GATEWAY_BASE_URL` + `JUDGE_API_KEY` — OpenAI /
 * OpenRouter / NVIDIA / …), or native Claude (`anthropic/…` + `ANTHROPIC_API_KEY`).
 *
 * @example
 * // env/environments.json → common: { "JUDGE_MODEL": "anthropic/claude-opus-4-8", "ANTHROPIC_API_KEY": "sk-..." }
 * await expect({ userMessage, botResponse, rubric }).toPassRubric({ minScore: 80 });
 */
export const manifest = {
  id: 'ai-judge',
  name: '@pwtap/plugin-ai-judge',
  devDependencies: {},
  scripts: {},
  envKeys: {
    JUDGE_MODEL: '',
    JUDGE_OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1',
    JUDGE_OLLAMA_KEEP_ALIVE: '30m',
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
    NVIDIA_API_KEY: '',
    OPENAI_API_KEY: '',
    GROQ_API_KEY: '',
    JUDGE_GATEWAY_BASE_URL: '',
    JUDGE_API_KEY: '',
  },
  fixture: {
    importFrom: '@pwtap/plugin-ai-judge',
    expect: { export: 'expect', alias: 'aiExpect' },
  },
  examples: [{ src: 'templates/tests', dest: 'tests/ai-judge' }],
  readmeSection: [
    '## AI Judge',
    '',
    'LLM-as-judge matchers on `expect`: `toPassRubric`, `toScoreAtLeast`, `toMatchImage`.',
    'Pick a model with `JUDGE_MODEL` in `env/environments.json` — `local/<ollama-model>`, a bare id for',
    'an OpenAI-compatible gateway (`JUDGE_GATEWAY_BASE_URL` + `JUDGE_API_KEY`), or `anthropic/<model>`',
    '(`ANTHROPIC_API_KEY`).',
    '',
    '```ts',
    'await expect({ userMessage, botResponse, rubric }).toPassRubric({ minScore: 80 });',
    '```',
  ].join('\n'),
};
