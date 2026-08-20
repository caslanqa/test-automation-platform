/**
 * `.heal/cache` — the same answer for the same question, without paying for it twice.
 *
 * The discipline is copied from `plugin-ai-judge`'s `verdictCache` rather than imported, because that
 * module's stored shape is a `JudgeVerdict`. Making it generic for one extra caller would widen a stable
 * published contract; forty lines here does not.
 *
 * Two details are load-bearing:
 *
 * - **The per-call nonce is deliberately absent from the key** (it changes every call and would sink
 *   every hit) while `HEAL_PROMPT_VERSION` and the taxonomy version are present, so a prompt or
 *   taxonomy change invalidates everything cached under the old one.
 * - **Write-then-rename.** A half-written file read by a concurrent process must look like a miss, not
 *   like a corrupt answer.
 *
 * `HEAL_CACHE=off` disables it, which is what the nightly drift check sets: a run that replays
 * yesterday's answers reports that nothing changed, and that is the one answer it must never produce by
 * construction.
 *
 * @example
 * const key = cacheKey({ model: 'groq/llama-3.3-70b', siteFingerprint: 'a1b2', evidence: text });
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { TAXONOMY_VERSION } from '../types.js';
import type { TriageReply } from './parse.js';
import { HEAL_PROMPT_VERSION } from './prompt.js';

export const CACHE_DIR = path.join('.heal', 'cache');

const OFF = new Set(['off', '0', 'false', 'no']);

/** On unless `HEAL_CACHE` says otherwise. */
export const cacheEnabled = (): boolean =>
  !OFF.has((process.env.HEAL_CACHE ?? '').trim().toLowerCase());

export interface CacheKeyInput {
  model: string;
  /** The model build, when the endpoint reports one — `ollama pull` replaces weights behind a tag. */
  revision?: string;
  siteFingerprint: string;
  /** The composed evidence, so a changed page or message is a different question. */
  evidence: string;
  /** Separates repeat samples of one question, which must not replay each other. */
  sample?: number;
}

export function cacheKey(input: CacheKeyInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        HEAL_PROMPT_VERSION,
        TAXONOMY_VERSION,
        input.model,
        input.revision ?? '',
        input.siteFingerprint,
        input.evidence,
        input.sample === undefined || input.sample === 0 ? '' : input.sample,
      ]),
    )
    .digest('hex');
}

export function readCached(projectDir: string, key: string): TriageReply | undefined {
  if (!cacheEnabled()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(projectDir, CACHE_DIR, `${key}.json`), 'utf8'),
    ) as TriageReply;
    return typeof parsed.class === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeCached(projectDir: string, key: string, reply: TriageReply): void {
  if (!cacheEnabled()) {
    return;
  }
  const dir = path.join(projectDir, CACHE_DIR);
  const target = path.join(dir, `${key}.json`);
  const temp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temp, JSON.stringify({ class: reply.class, reasoning: reply.reasoning }));
    fs.renameSync(temp, target);
  } catch {
    fs.rmSync(temp, { force: true });
  }
}
