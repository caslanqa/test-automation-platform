import type { JudgeVerdict } from '../types.js';

/**
 * The verdict's wire shape, handed to providers that support structured output (Ollama's `format`,
 * an OpenAI-compatible `response_format`). Property order matches the prompt — reasoning first, so
 * the verdict follows the reasoning instead of being justified after the fact.
 * @example body.format = VERDICT_SCHEMA; // Ollama /api/chat
 */
export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: { type: 'string' },
    score: { type: 'integer', minimum: 0, maximum: 100 },
    pass: { type: 'boolean' },
  },
  required: ['reasoning', 'score', 'pass'],
  additionalProperties: false,
} as const;

/** A reply that carried no usable verdict; the orchestrator retries such a call once with a reminder. */
export class VerdictParseError extends Error {
  readonly raw: string;

  constructor(raw: string) {
    super(`[ai-judge] model did not return valid JSON: ${raw.slice(0, 300)}`);
    this.name = 'VerdictParseError';
    this.raw = raw;
  }
}

/**
 * The first balanced JSON object in a reply, after dropping any closed thinking block. Scanning braces
 * (rather than trimming a fence) is what survives the shapes small local models actually emit:
 * `<think>…</think>`, prose before the JSON, or a trailing "Hope this helps!". An unterminated
 * `<think>` keeps its content — cutting to the end of the string would throw away the verdict too.
 */
function extractJsonObject(raw: string): string | undefined {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '');
  const start = text.indexOf('{');
  if (start === -1) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}' && --depth === 0) {
      return text.slice(start, i + 1);
    }
  }

  return undefined;
}

const TRUTHY = /^(true|yes|pass(ed)?|ok|match(es)?)$/i;

/** Read the pass field however the model spelled it; with no verdict field at all, use the midpoint. */
function coercePass(value: unknown, score: number): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return TRUTHY.test(value.trim());
  }
  if (typeof value === 'number') {
    return value !== 0;
  }

  return score >= 50;
}

/** Read the score as a number in 0-100; with no score field, derive the extremes from the verdict. */
function coerceScore(value: unknown, passValue: unknown): number {
  const raw =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.replace(/[^\d.-]/g, ''))
        : NaN;
  if (Number.isFinite(raw)) {
    return Math.min(100, Math.max(0, Math.round(raw)));
  }

  return coercePass(passValue, 0) ? 100 : 0;
}

/**
 * Parse a model reply into a verdict, tolerating the near-misses that are not worth failing a test
 * over: a thinking block, prose around the JSON, `"pass": "yes"`, a 0-100 score out of range, or a
 * field named `reason`/`rating`/`verdict`. A reply with no JSON object at all throws
 * {@link VerdictParseError}.
 * @example parseVerdict('<think>…</think>{"reasoning":"ok","score":"92","pass":"yes"}');
 */
export function parseVerdict(raw: string): JudgeVerdict {
  const json = extractJsonObject(raw);
  if (json === undefined) {
    throw new VerdictParseError(raw);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new VerdictParseError(raw);
  }

  const passValue = parsed.pass ?? parsed.passed ?? parsed.verdict;
  const score = coerceScore(parsed.score ?? parsed.rating, passValue);
  const reasoning = parsed.reasoning ?? parsed.reason;

  return {
    pass: coercePass(passValue, score),
    score,
    reasoning: typeof reasoning === 'string' ? reasoning : '',
  };
}
