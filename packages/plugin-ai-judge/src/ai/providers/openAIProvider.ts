import { imageToDataUri } from '../judge/judgePrompt.js';
import { parseVerdict } from '../judge/verdictParser.js';
import type { ChatCompletionResponse, JudgeVerdict } from '../types.js';
import { type AIProvider, JudgeHttpError } from './provider.js';

/** Base URL of the default OpenAI-compatible gateway (JUDGE_GATEWAY_BASE_URL) — also used by discovery. */
export function openAIBase(): string {
  const baseUrl = process.env.JUDGE_GATEWAY_BASE_URL;
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error('[ai-judge] JUDGE_GATEWAY_BASE_URL is not set (env/environments.json)');
  }
  return baseUrl;
}

/** API key for the default gateway. */
export function openAIApiKey(): string {
  const apiKey = process.env.JUDGE_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(
      '[ai-judge] JUDGE_API_KEY is not set (required for the default OpenAI-compatible gateway)',
    );
  }
  return apiKey;
}

export interface OpenAICompatibleConfig {
  /** Label for error messages (e.g. 'OpenRouter'). */
  label: string;
  /** Fixed base URL; omit to read JUDGE_GATEWAY_BASE_URL at call time (the default gateway). */
  baseUrl?: string;
  /** Env vars to read the API key from — first non-empty wins. */
  apiKeyEnv: string[];
}

function resolveBaseUrl(cfg: OpenAICompatibleConfig): string {
  const baseUrl = cfg.baseUrl ?? process.env.JUDGE_GATEWAY_BASE_URL;
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error(`[ai-judge] ${cfg.label}: base URL not set (set JUDGE_GATEWAY_BASE_URL)`);
  }
  return baseUrl;
}

function resolveApiKey(cfg: OpenAICompatibleConfig): string {
  for (const name of cfg.apiKeyEnv) {
    const value = process.env[name];
    if (value !== undefined && value.length > 0) {
      return value;
    }
  }
  throw new Error(`[ai-judge] ${cfg.label}: API key not set (set ${cfg.apiKeyEnv.join(' or ')})`);
}

/**
 * Build a judge provider for ANY OpenAI-compatible `/chat/completions` endpoint — OpenAI, OpenRouter,
 * NVIDIA, Groq, Together, a local gateway. Text-only, or multimodal via `image_url` parts.
 *
 * @example
 * const openrouter = createOpenAICompatibleProvider({
 *   label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: ['OPENROUTER_API_KEY'],
 * });
 */
export function createOpenAICompatibleProvider(cfg: OpenAICompatibleConfig): AIProvider {
  return {
    async judge(model, systemPrompt, userText, images): Promise<JudgeVerdict> {
      const baseUrl = resolveBaseUrl(cfg);
      const apiKey = resolveApiKey(cfg);

      const userContent =
        images.length === 0
          ? userText
          : [
              { type: 'text', text: userText },
              ...images.map(image => ({
                type: 'image_url',
                image_url: { url: imageToDataUri(image) },
              })),
            ];

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          temperature: 0,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
        }),
      });

      if (!response.ok) {
        throw new JudgeHttpError(
          response.status,
          `[ai-judge] ${cfg.label} ${response.status} (${baseUrl}): ${await response.text()}`,
        );
      }

      const data = (await response.json()) as ChatCompletionResponse;
      return parseVerdict(data.choices?.[0]?.message?.content ?? '');
    },
  };
}

/**
 * Default gateway (prefix-less): any OpenAI-compatible endpoint configured entirely via env
 * (JUDGE_GATEWAY_BASE_URL + JUDGE_API_KEY). Named providers (openrouter/, nvidia/, …) are registered
 * separately in the provider registry.
 */
export const openAIProvider: AIProvider = createOpenAICompatibleProvider({
  label: 'gateway',
  apiKeyEnv: ['JUDGE_API_KEY'],
});
