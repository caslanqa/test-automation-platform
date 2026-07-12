import type { JudgeVerdict } from '../types';

/**
 * The contract every judge backend implements. Adding a new provider (Gemini direct, Anthropic
 * direct, …) means implementing this and registering it in the router — judge.ts stays untouched.
 */
export interface AIProvider {
  /**
   * Grade the material described by the system + user text. Pure transport: prompt policy (rubric
   * vs compare mode) is decided by the caller and passed in.
   * @param model The backend-native model id (no routing prefix — the router strips it).
   * @param systemPrompt The system instruction (rubric-mode or compare-mode prompt).
   * @param userText The composed rubric/criteria + message + response payload.
   * @param images Ordered images to attach (empty for text-only; [actual, reference] in compare mode).
   */
  judge(
    model: string,
    systemPrompt: string,
    userText: string,
    images: Array<string | Buffer>
  ): Promise<JudgeVerdict>;
}

/**
 * Error carrying the HTTP status from a provider call, so the router can distinguish a retryable
 * "model unavailable/forbidden" (401/403/404) from a hard failure and advance to the next cloud
 * fallback candidate.
 */
export class JudgeHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'JudgeHttpError';
  }
}
