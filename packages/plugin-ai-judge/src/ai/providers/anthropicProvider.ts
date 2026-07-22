import { imageToDataUri } from '../judge/judgePrompt.js';
import { parseVerdict } from '../judge/verdictParser.js';
import type { JudgeVerdict } from '../types.js';
import { type AIProvider, JudgeHttpError } from './provider.js';

/** API key for native Claude judging (Anthropic Messages API). */
function anthropicApiKey(): string {
  const key = process.env.JUDGE_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (key === undefined || key.length === 0) {
    throw new Error(
      '[ai-judge] ANTHROPIC_API_KEY is not set (required to judge with native Claude, ' +
        'e.g. JUDGE_MODEL=anthropic/claude-opus-4-8)',
    );
  }
  return key;
}

type MediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** Split a data URI into Anthropic's { media_type, data } base64 image-source shape. */
function toImageSource(image: string | Buffer): { media_type: MediaType; data: string } {
  const match = /^data:(.+?);base64,(.*)$/s.exec(imageToDataUri(image));
  if (match === null) {
    throw new Error('[ai-judge] could not encode image for the Anthropic provider');
  }
  return { media_type: match[1] as MediaType, data: match[2] };
}

/**
 * Native Claude judge via the Anthropic Messages API. `@anthropic-ai/sdk` is imported dynamically so
 * Ollama-only or gateway-only projects never load it. Routed by the `anthropic/` model prefix — e.g.
 * `JUDGE_MODEL=anthropic/claude-opus-4-8` — and authenticated with `ANTHROPIC_API_KEY`. Kept native
 * (not proxied through OpenRouter) so users can bring their own Anthropic key directly.
 *
 * @example
 * // env/environments.json → common: { "JUDGE_MODEL": "anthropic/claude-opus-4-8", "ANTHROPIC_API_KEY": "..." }
 * await expect({ userMessage, botResponse, rubric }).toPassRubric();
 */
export const anthropicProvider: AIProvider = {
  async judge(model, systemPrompt, userText, images): Promise<JudgeVerdict> {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: anthropicApiKey() });

    const content = [
      { type: 'text' as const, text: userText },
      ...images.map(image => ({
        type: 'image' as const,
        source: { type: 'base64' as const, ...toImageSource(image) },
      })),
    ];

    try {
      const message = await client.messages.create({
        model,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content }],
      });
      const text = message.content
        .map(block => (block.type === 'text' ? block.text : ''))
        .join('\n');
      return parseVerdict(text);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (typeof status === 'number') {
        throw new JudgeHttpError(
          status,
          `[ai-judge] Anthropic ${status}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
  },
};
