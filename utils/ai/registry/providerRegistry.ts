import type { AIJudgeConfig } from '@config/aiJudge.config';

import type { RegistrySnapshot } from '../types';
import { discoverOllamaModels } from './ollamaDiscovery';
import { discoverOpenAIModels } from './openAIDiscovery';

/** Process-wide cache — discovery is expensive and its result is stable within a test run. */
let snapshot: RegistrySnapshot | null = null;

/** Normalize any thrown value to a readable string for the errors list. */
function errText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Return the model registry, discovering from both providers if the cache is empty or stale.
 * Discovery runs in parallel with `Promise.allSettled`, so one provider being down (Ollama not
 * running, or 9Router unconfigured/unreachable) degrades to the other rather than failing the
 * call — the failure is recorded in `snapshot.errors` for diagnostics.
 */
export async function getRegistry(config: AIJudgeConfig): Promise<RegistrySnapshot> {
  if (snapshot !== null && Date.now() - snapshot.fetchedAt < config.registryCacheTtlMs) {
    return snapshot;
  }

  const [ollama, openai] = await Promise.allSettled([
    discoverOllamaModels(),
    discoverOpenAIModels(config),
  ]);

  const models = [
    ...(ollama.status === 'fulfilled' ? ollama.value : []),
    ...(openai.status === 'fulfilled' ? openai.value : []),
  ];
  const errors = [
    ...(ollama.status === 'rejected' ? [`Ollama: ${errText(ollama.reason)}`] : []),
    ...(openai.status === 'rejected' ? [`9Router: ${errText(openai.reason)}`] : []),
  ];

  snapshot = { models, fetchedAt: Date.now(), errors };
  return snapshot;
}

/** Clear the cached snapshot. Test hook / used after config changes that affect discovery. */
export function resetRegistry(): void {
  snapshot = null;
}
