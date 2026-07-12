import { imageToDataUri } from '../judge/judgePrompt';
import { parseVerdict } from '../judge/verdictParser';
import type { ChatCompletionResponse, JudgeVerdict } from '../types';
import { type AIProvider, JudgeHttpError } from './provider';

/** Base URL of the 9Router gateway (OpenAI-compatible), e.g. http://127.0.0.1:20128/v1. */
export function openAIBase(): string {
  const baseUrl = process.env.JUDGE_GATEWAY_BASE_URL;
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error('[ai-judge] JUDGE_GATEWAY_BASE_URL is not set (env/environments.json)');
  }

  return baseUrl;
}

/** API key for the 9Router gateway. */
export function openAIApiKey(): string {
  const apiKey = process.env.JUDGE_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('[ai-judge] JUDGE_API_KEY is not set (required for the 9Router gateway)');
  }

  return apiKey;
}

/** Judge via the 9Router gateway using the OpenAI-compatible /chat/completions endpoint. */
export const openAIProvider: AIProvider = {
  async judge(model, systemPrompt, userText, images): Promise<JudgeVerdict> {
    const baseUrl = openAIBase();
    const apiKey = openAIApiKey();

    // Plain string for text-only judging; an OpenAI-style multimodal array when images are given
    // (one image_url part per image — [actual, reference] in compare mode).
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
        `[ai-judge] judge backend ${response.status} (${baseUrl}): ${await response.text()}`
      );
    }

    const data = (await response.json()) as ChatCompletionResponse;

    return parseVerdict(data.choices?.[0]?.message?.content ?? '');
  },
};
