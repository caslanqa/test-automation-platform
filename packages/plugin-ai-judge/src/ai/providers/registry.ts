import { anthropicProvider } from './anthropicProvider.js';
import { ollamaApiBase, ollamaProvider } from './ollamaProvider.js';
import { createOpenAICompatibleProvider, openAIProvider } from './openAIProvider.js';
import type { AIProvider } from './provider.js';

/**
 * Where a kind's requests go, and in which wire format.
 *
 * Separate from {@link AIProvider} because that interface returns a `JudgeVerdict`, and a consumer
 * asking a different question — `@pwtap/plugin-heal` asks a model to pick a failure class — needs the
 * transport without the verdict shape. Exposing the endpoints rather than copying them keeps one table
 * of gateway URLs in the repo: a second copy drifts, and a drifted base URL is a confusing 404 for
 * whoever set `groq/…` in their config.
 */
export interface JudgeEndpoint {
  /** Label for error messages, e.g. 'Groq'. */
  label: string;
  /** Which request shape the endpoint expects. */
  wire: 'openai' | 'ollama' | 'anthropic';
  /** Resolve the base URL, throwing with an actionable message when it is not configured. */
  baseUrl: () => string;
  /** Resolve the credential, or undefined for an endpoint that needs none (local Ollama). */
  apiKey: () => string | undefined;
}

interface ProviderEntry {
  kind: string;
  provider: AIProvider;
  /** Routing prefix (e.g. 'openrouter/'). A model id with this prefix routes here. Omit for the default. */
  prefix?: string;
  /** Transport details, for consumers that need a reply shape other than `JudgeVerdict`. */
  endpoint?: JudgeEndpoint;
}

/** First non-empty of the named environment variables. */
const keyFrom =
  (...names: string[]): (() => string | undefined) =>
  () =>
    names.map(name => process.env[name]).find(value => value !== undefined && value.length > 0);

/** The base URL a named OpenAI-compatible gateway is fixed to. */
const fixedBase =
  (url: string): (() => string) =>
  () =>
    url;

const entries = new Map<string, ProviderEntry>();

function register(entry: ProviderEntry): void {
  entries.set(entry.kind, entry);
}

// Local + native Claude (native so you bring your own Anthropic key, not proxied through OpenRouter).
register({
  kind: 'ollama',
  provider: ollamaProvider,
  prefix: 'local/',
  endpoint: { label: 'Ollama', wire: 'ollama', baseUrl: ollamaApiBase, apiKey: () => undefined },
});
register({
  kind: 'anthropic',
  provider: anthropicProvider,
  prefix: 'anthropic/',
  endpoint: {
    label: 'Anthropic',
    wire: 'anthropic',
    baseUrl: fixedBase('https://api.anthropic.com'),
    apiKey: keyFrom('JUDGE_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'),
  },
});

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
  endpoint: {
    label: 'OpenRouter',
    wire: 'openai',
    baseUrl: fixedBase('https://openrouter.ai/api/v1'),
    apiKey: keyFrom('OPENROUTER_API_KEY', 'JUDGE_API_KEY'),
  },
});
register({
  kind: 'nvidia',
  prefix: 'nvidia/',
  provider: createOpenAICompatibleProvider({
    label: 'NVIDIA',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKeyEnv: ['NVIDIA_API_KEY', 'JUDGE_API_KEY'],
  }),
  endpoint: {
    label: 'NVIDIA',
    wire: 'openai',
    baseUrl: fixedBase('https://integrate.api.nvidia.com/v1'),
    apiKey: keyFrom('NVIDIA_API_KEY', 'JUDGE_API_KEY'),
  },
});
register({
  kind: 'openai-hosted',
  prefix: 'openai/',
  provider: createOpenAICompatibleProvider({
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: ['OPENAI_API_KEY', 'JUDGE_API_KEY'],
  }),
  endpoint: {
    label: 'OpenAI',
    wire: 'openai',
    baseUrl: fixedBase('https://api.openai.com/v1'),
    apiKey: keyFrom('OPENAI_API_KEY', 'JUDGE_API_KEY'),
  },
});
register({
  kind: 'groq',
  prefix: 'groq/',
  provider: createOpenAICompatibleProvider({
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: ['GROQ_API_KEY', 'JUDGE_API_KEY'],
  }),
  endpoint: {
    label: 'Groq',
    wire: 'openai',
    baseUrl: fixedBase('https://api.groq.com/openai/v1'),
    apiKey: keyFrom('GROQ_API_KEY', 'JUDGE_API_KEY'),
  },
});

// Default (prefix-less): any other OpenAI-compatible endpoint via JUDGE_GATEWAY_BASE_URL + JUDGE_API_KEY.
register({
  kind: 'openai',
  provider: openAIProvider,
  endpoint: {
    label: 'gateway',
    wire: 'openai',
    baseUrl: () => {
      const baseUrl = process.env.JUDGE_GATEWAY_BASE_URL;
      if (baseUrl === undefined || baseUrl.length === 0) {
        throw new Error('[ai-judge] JUDGE_GATEWAY_BASE_URL is not set (env/environments.json)');
      }
      return baseUrl;
    },
    apiKey: keyFrom('JUDGE_API_KEY'),
  },
});

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
  options?: { prefix?: string; endpoint?: JudgeEndpoint },
): void {
  register({ kind, provider, prefix: options?.prefix, endpoint: options?.endpoint });
}

/**
 * Transport details for a kind, or undefined when it registered none.
 *
 * A custom provider serves the judge through {@link AIProvider} alone; passing an `endpoint` as well
 * is what lets other pwtap tools — the healer's escalation tier — route to it too.
 */
export function endpointForKind(kind: string): JudgeEndpoint | undefined {
  return entries.get(kind)?.endpoint;
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
