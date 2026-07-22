import { anthropicProvider } from './anthropicProvider.js';
import { ollamaProvider } from './ollamaProvider.js';
import { createOpenAICompatibleProvider, openAIProvider } from './openAIProvider.js';
import type { AIProvider } from './provider.js';

interface ProviderEntry {
  kind: string;
  provider: AIProvider;
  /** Routing prefix (e.g. 'openrouter/'). A model id with this prefix routes here. Omit for the default. */
  prefix?: string;
}

const entries = new Map<string, ProviderEntry>();

function register(entry: ProviderEntry): void {
  entries.set(entry.kind, entry);
}

// Local + native Claude (native so you bring your own Anthropic key, not proxied through OpenRouter).
register({ kind: 'ollama', provider: ollamaProvider, prefix: 'local/' });
register({ kind: 'anthropic', provider: anthropicProvider, prefix: 'anthropic/' });

// Named OpenAI-compatible gateways — pick one via the model prefix; no manual base URL needed.
// The stripped remainder is the endpoint's own model id, e.g. openrouter/anthropic/claude-3.5-sonnet.
register({
  kind: 'openrouter',
  prefix: 'openrouter/',
  provider: createOpenAICompatibleProvider({
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: ['OPENROUTER_API_KEY', 'JUDGE_API_KEY'],
  }),
});
register({
  kind: 'nvidia',
  prefix: 'nvidia/',
  provider: createOpenAICompatibleProvider({
    label: 'NVIDIA',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKeyEnv: ['NVIDIA_API_KEY', 'JUDGE_API_KEY'],
  }),
});
register({
  kind: 'openai-hosted',
  prefix: 'openai/',
  provider: createOpenAICompatibleProvider({
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: ['OPENAI_API_KEY', 'JUDGE_API_KEY'],
  }),
});
register({
  kind: 'groq',
  prefix: 'groq/',
  provider: createOpenAICompatibleProvider({
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: ['GROQ_API_KEY', 'JUDGE_API_KEY'],
  }),
});

// Default (prefix-less): any other OpenAI-compatible endpoint via JUDGE_GATEWAY_BASE_URL + JUDGE_API_KEY.
register({ kind: 'openai', provider: openAIProvider });

/**
 * Register a custom judge provider — the escape hatch for anything that isn't already built in
 * (a native Gemini/Cohere transport, a bespoke internal gateway). Implement `AIProvider`, give it a
 * routing `prefix`, then name models `<prefix>...`. Call from a setup module loaded before tests run.
 *
 * @example
 * registerProvider('gemini', new GeminiProvider(), { prefix: 'gemini/' });
 * // then: JUDGE_MODEL=gemini/gemini-2.0-flash
 */
export function registerProvider(
  kind: string,
  provider: AIProvider,
  options?: { prefix?: string },
): void {
  register({ kind, provider, prefix: options?.prefix });
}

/** Resolve a model id to its provider kind by registered prefix (default 'openai'). */
export function kindForModel(modelId: string): string {
  for (const entry of entries.values()) {
    if (entry.prefix !== undefined && modelId.startsWith(entry.prefix)) {
      return entry.kind;
    }
  }
  return 'openai';
}

/** The concrete provider registered for `kind`. */
export function providerForKind(kind: string): AIProvider {
  const entry = entries.get(kind);
  if (entry === undefined) {
    throw new Error(`[ai-judge] no judge provider registered for kind '${kind}'`);
  }
  return entry.provider;
}

/** Strip a model id's routing prefix, yielding the backend-native model string. */
export function stripPrefix(modelId: string, kind: string): string {
  const entry = entries.get(kind);
  return entry?.prefix !== undefined && modelId.startsWith(entry.prefix)
    ? modelId.slice(entry.prefix.length)
    : modelId;
}
