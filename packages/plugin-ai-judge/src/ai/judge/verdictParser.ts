import type { Criterion, JudgeVerdict } from '../types.js';

/**
 * The verdict's wire shape, handed to providers that support structured output (Ollama's `format`,
 * an OpenAI-compatible `response_format`). Property order matches the prompt — the checklist and the
 * reasoning come first, so the verdict follows them instead of being justified after the fact.
 * @example body.format = VERDICT_SCHEMA; // Ollama /api/chat
 */
export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    criteria: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          criterion: { type: 'string' },
          why: { type: 'string' },
          met: { type: 'boolean' },
        },
        required: ['criterion', 'why', 'met'],
        additionalProperties: false,
      },
    },
    reasoning: { type: 'string' },
    score: { type: 'integer', minimum: 0, maximum: 100 },
    pass: { type: 'boolean' },
  },
  required: ['criteria', 'reasoning', 'score', 'pass'],
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
export function extractJsonObject(raw: string): string | undefined {
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

/** Keep the checklist entries that carry an actual requirement and a verdict on it. */
function coerceCriteria(value: unknown): Criterion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap(entry => {
    const item = entry as Record<string, unknown>;
    const criterion = typeof item?.criterion === 'string' ? item.criterion : item?.requirement;
    if (typeof criterion !== 'string' || criterion.length === 0) {
      return [];
    }

    return [
      {
        criterion,
        met: coercePass(item.met ?? item.satisfied ?? item.pass, 0),
        ...(typeof item.why === 'string' && item.why.length > 0 ? { why: item.why } : {}),
      },
    ];
  });
}

/**
 * The share of met criteria, 0-100. Criteria count equally on purpose: asked to weight them, a model
 * gives the same rubric different weights on different runs, which moves the score without telling
 * anyone anything.
 */
function scoreFromCriteria(criteria: Criterion[]): number {
  return Math.round((criteria.filter(item => item.met).length / criteria.length) * 100);
}

/**
 * Parse a model reply into a verdict, tolerating the near-misses that are not worth failing a test
 * over: a thinking block, prose around the JSON, `"pass": "yes"`, a 0-100 score out of range, or a
 * field named `reason`/`rating`/`verdict`. When the reply carries a checklist, the score is computed
 * from it and the verdict needs every criterion met — a holistic "pass" over an unmet requirement is
 * the judge contradicting itself, and in a test that has to fail. A reply with no JSON object at all
 * throws {@link VerdictParseError}.
 * @example parseVerdict('{"criteria":[{"criterion":"states 9am","met":false}],"score":90,"pass":true}');
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
  const criteria = coerceCriteria(parsed.criteria ?? parsed.checklist);
  const score =
    criteria.length > 0
      ? scoreFromCriteria(criteria)
      : coerceScore(parsed.score ?? parsed.rating, passValue);
  const reasoning = parsed.reasoning ?? parsed.reason;

  return {
    pass: coercePass(passValue, score) && criteria.every(item => item.met),
    score,
    reasoning: typeof reasoning === 'string' ? reasoning : '',
    ...(criteria.length > 0 ? { criteria } : {}),
  };
}
