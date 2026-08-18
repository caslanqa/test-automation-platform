import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import type { JudgeInput, JudgeVerdict } from '../types.js';
import { PROMPT_VERSION, collectImages, imageToBase64 } from './judgePrompt.js';

const OFF = new Set(['off', '0', 'false', 'no']);

/** Resolved per call, not at import: the cache belongs to the project the run happens in. */
function cacheDir(): string {
  return path.join(process.cwd(), '.judge', 'cache');
}

/** On unless `JUDGE_CACHE` says otherwise — set `JUDGE_CACHE=off` to re-judge everything from scratch. */
function enabled(): boolean {
  return !OFF.has((process.env.JUDGE_CACHE ?? '').trim().toLowerCase());
}

/**
 * Key for one judging call: same model and same material means the same verdict, so a re-run costs
 * nothing and cannot drift. The per-call nonce is deliberately absent — it changes every call and
 * would sink every hit — while `PROMPT_VERSION` is present, so a prompt change invalidates the cache.
 * `sample` separates repeat samples of one input (`samples: 3`), which must not replay each other.
 * @example cacheKey('local/qwen3.5:9b', { rubric: 'Must state 9am.', botResponse: 'We open at 9am.' });
 */
export function cacheKey(modelId: string, input: JudgeInput, sample = 0): string {
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify([
      PROMPT_VERSION,
      modelId,
      input.rubric ?? '',
      input.userMessage ?? '',
      input.botResponse ?? '',
      input.referenceImage !== undefined, // rubric vs compare mode: same material, different question
      sample === 0 ? '' : sample, // keeps a single-sample key identical to what it was before voting
    ]),
  );
  for (const image of collectImages(input)) {
    hash.update(imageToBase64(image));
  }

  return hash.digest('hex');
}

/** The cached verdict for a key, or undefined when absent, unreadable, or caching is off. */
export function readCached(key: string): JudgeVerdict | undefined {
  if (!enabled()) {
    return undefined;
  }
  try {
    const { pass, score, reasoning, criteria } = JSON.parse(
      fs.readFileSync(path.join(cacheDir(), `${key}.json`), 'utf8'),
    ) as JudgeVerdict;
    if (typeof pass !== 'boolean' || typeof score !== 'number') {
      return undefined;
    }

    return { pass, score, reasoning, ...(Array.isArray(criteria) ? { criteria } : {}) };
  } catch {
    return undefined;
  }
}

/** Store a verdict (routing trace stripped — it describes the call, not the judgement). */
export function writeCached(key: string, verdict: JudgeVerdict): void {
  if (!enabled()) {
    return;
  }
  const body = JSON.stringify({
    pass: verdict.pass,
    score: verdict.score,
    reasoning: verdict.reasoning,
    ...(verdict.criteria === undefined ? {} : { criteria: verdict.criteria }),
  });
  const target = path.join(cacheDir(), `${key}.json`);
  const temp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    // Write-then-rename: parallel Playwright workers judge concurrently, and a half-written file read
    // by the next worker would look like a corrupt verdict rather than a miss.
    fs.writeFileSync(temp, body);
    fs.renameSync(temp, target);
  } catch {
    fs.rmSync(temp, { force: true });
  }
}
