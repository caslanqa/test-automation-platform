import { imageToBase64 } from '../judge/judgePrompt.js';
import { parseVerdict } from '../judge/verdictParser.js';
import type { JudgeVerdict } from '../types.js';
import { withModelGate } from './ollamaGate.js';
import { type AIProvider, JudgeHttpError } from './provider.js';

/** Strip a trailing /v1 from JUDGE_OLLAMA_BASE_URL to reach Ollama's native API root. */
export function ollamaApiBase(): string {
  const v1 = process.env.JUDGE_OLLAMA_BASE_URL;
  if (v1 === undefined || v1.length === 0) {
    throw new Error('[ai-judge] JUDGE_OLLAMA_BASE_URL is not set (env/environments.json)');
  }

  return v1.replace(/\/v1\/?$/, '');
}

/**
 * Judge via local Ollama using the NATIVE /api/chat endpoint with `think: false`. This is
 * essential for thinking models (qwen3.x): leaving thinking on costs ~40s+ per call, and the
 * OpenAI-compatible /v1 endpoint cannot disable it. Images go as raw base64 in `images` (one entry
 * for single-image judging, [actual, reference] for compare mode).
 */
export const ollamaProvider: AIProvider = {
  async judge(model, systemPrompt, userText, images): Promise<JudgeVerdict> {
    const apiBase = ollamaApiBase();
    // Prepend a per-call nonce so Ollama can't reuse a previous call's KV-cache prefix: with an
    // identical prompt + shared first image, cache reuse would skip re-processing a differing second
    // image (compare mode), making the model "see" the wrong image. The judge ignores this marker.
    const nonce = `[req:${Date.now().toString(36)}${Math.round(performance.now() * 1000).toString(36)}]`;
    const userMessage: Record<string, unknown> = { role: 'user', content: `${nonce}\n${userText}` };
    if (images.length > 0) {
      userMessage.images = images.map(imageToBase64);
    }

    // Serialize across workers and keep a single model resident at a time (see ollamaGate).
    return withModelGate(model, apiBase, async () => {
      const response = await fetch(`${apiBase}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          think: false, // disable thinking → fast (qwen3.x reasoning adds ~40s/call otherwise)
          keep_alive: process.env.JUDGE_OLLAMA_KEEP_ALIVE ?? '30m', // keep resident across the run
          options: { temperature: 0 },
          messages: [{ role: 'system', content: systemPrompt }, userMessage],
        }),
      });

      if (!response.ok) {
        throw new JudgeHttpError(
          response.status,
          `[ai-judge] Ollama ${response.status}: ${await response.text()}`,
        );
      }

      const data = (await response.json()) as { message?: { content?: string } };

      return parseVerdict(data.message?.content ?? '');
    });
  },
};
