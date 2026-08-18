import type { JudgeVerdict } from '../types.js';

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
    images: Array<string | Buffer>,
  ): Promise<JudgeVerdict>;
}

/**
 * Error carrying the HTTP status from a provider call, so the router can distinguish a retryable
 * "model unavailable/forbidden" (401/403/404) from a hard failure and advance to the next cloud
 * fallback candidate.
 */
export class JudgeHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'JudgeHttpError';
    this.status = status;
  }
}

/**
 * Deadline for a single judge request (`JUDGE_TIMEOUT_MS`, default 3 min). A large local vision model
 * is genuinely slow, but an unbounded request holds a Playwright worker until the whole run times out.
 * @example JUDGE_TIMEOUT_MS=600000 // ten minutes, for a 70B model on CPU
 */
export function judgeTimeoutMs(): number {
  const raw = Number(process.env.JUDGE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 180_000;
}

/** Statuses that mean "ask again later" rather than "this call is wrong". */
const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Exponential backoff with jitter, so parallel workers that hit the same quota do not retry in lockstep. */
function backoffMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.random() * 250;
}

/** The server's own `Retry-After` (seconds or HTTP date), when it sent one. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return seconds * 1000;
  }
  const date = Date.parse(header);

  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: string }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * POST to a judge endpoint under the request deadline, retrying rate limits, 5xx and network faults.
 * Parallel Playwright workers share one quota, so a 429 is a wait rather than a verdict; a timeout is
 * not retried, because the deadline is already spent.
 * @example const response = await judgeFetch('Groq', `${baseUrl}/chat/completions`, { method: 'POST', body });
 */
export async function judgeFetch(
  label: string,
  url: string,
  init: RequestInit,
  attempts = 3,
): Promise<Response> {
  const timeoutMs = judgeTimeoutMs();

  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      // A fresh signal per attempt — an AbortSignal.timeout already consumed is permanently aborted.
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (isTimeout(error)) {
        throw new Error(
          `[ai-judge] ${label} timed out after ${timeoutMs}ms — raise JUDGE_TIMEOUT_MS or judge with a smaller model`,
        );
      }
      if (attempt >= attempts) {
        throw error;
      }
      await sleep(backoffMs(attempt));
      continue;
    }

    if (!TRANSIENT.has(response.status) || attempt >= attempts) {
      return response;
    }

    const wait = retryAfterMs(response) ?? backoffMs(attempt);
    console.warn(
      `[ai-judge] ${label} ${response.status} — retrying in ${Math.round(wait)}ms (attempt ${attempt}/${attempts - 1})`,
    );
    await sleep(wait);
  }
}
