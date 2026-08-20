/**
 * Reading a model's answer, defensively.
 *
 * Two rules, and the second is the one that makes the tier safe: the reply is parsed tolerantly (a
 * `<think>` block, prose around the JSON, a differently-named field), and then **validated against a
 * closed set**. Anything outside `CLASSES` becomes `unknown` — not an error, not a best guess, and
 * certainly not a new class invented by a model reading a hostile page.
 *
 * @example
 * parseTriageReply('<think>hmm</think>{"class":"flaky","reasoning":"retry passed"}').class; // 'flaky'
 * parseTriageReply('{"class":"definitely-drift"}').class;                                   // 'unknown'
 */
import type { TriageClass } from '../triage/classify.js';
import { CLASSES } from './prompt.js';

export interface TriageReply {
  class: TriageClass;
  reasoning: string;
  /** Set when the reply could not be read at all, so the caller can re-ask once. */
  unparseable?: boolean;
}

const KNOWN = new Set<string>(CLASSES);

/**
 * The first balanced JSON object in a reply.
 *
 * Duplicated from `plugin-ai-judge`'s `extractJsonObject` **only as a fallback**: the real one is
 * imported when the judge plugin is installed, and this copy keeps the tier working when it is not.
 * The behaviour that matters is the same — drop closed thinking blocks, then scan braces rather than
 * trimming a fence, because a small local model puts prose on both sides of its JSON.
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
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
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
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

/**
 * Parse a reply into a class. Never throws: an unreadable answer is an `unknown` with `unparseable`
 * set, which is what the caller needs to decide whether re-asking is worth a second call.
 */
export function parseTriageReply(
  raw: string,
  extract: (raw: string) => string | undefined = extractJsonObject,
): TriageReply {
  const json = extract(raw);
  if (json === undefined) {
    return { class: 'unknown', reasoning: '', unparseable: true };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { class: 'unknown', reasoning: '', unparseable: true };
  }

  // Tolerated aliases, in the judge's spirit: worth a field name, not worth a failed call.
  const raw_class = parsed.class ?? parsed.classification ?? parsed.category ?? parsed.verdict;
  const reasoning = parsed.reasoning ?? parsed.reason ?? parsed.explanation;
  const named = typeof raw_class === 'string' ? raw_class.trim().toLowerCase() : '';

  return {
    // The closed set. A model that answers something else has told us nothing usable, and inventing a
    // mapping for it is how an unrecognised string becomes an authorised code change.
    class: KNOWN.has(named) ? (named as TriageClass) : 'unknown',
    reasoning: typeof reasoning === 'string' ? reasoning : '',
  };
}
