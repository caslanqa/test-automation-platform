import type { JudgeVerdict } from '../types';

/** Strip an optional ```json ... ``` fence, then parse the verdict JSON. */
export function parseVerdict(raw: string): JudgeVerdict {
  const json = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();

  try {
    return JSON.parse(json) as JudgeVerdict;
  } catch {
    throw new Error(`[ai-judge] model did not return valid JSON: ${raw.slice(0, 300)}`);
  }
}
