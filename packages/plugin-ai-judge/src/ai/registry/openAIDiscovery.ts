import type { AIJudgeConfig } from '../../config/aiJudge.config.js';

import { openAIApiKey, openAIBase } from '../providers/openAIProvider.js';
import type { ModelProfile } from '../types.js';

/** Discovery HTTP timeout — a down/unauthorized gateway must fail fast, not hang. */
const DISCOVERY_TIMEOUT_MS = 4000;

/** Subset of a 9Router /models entry. The gateway returns only id + owner — no caps, no pricing. */
interface OpenAIModel {
  id: string;
  owned_by?: string;
}

/**
 * Discover models served by the 9Router gateway via the OpenAI-standard /models endpoint. The
 * response carries only `id` and `owned_by` (no capability or pricing data), so vision support is
 * inferred from the id using config.visionHints. Provider-agnostic: whatever owner the gateway
 * reports (gh, openai, anthropic, …) is captured in `ownedBy` and the id is used verbatim.
 */
export async function discoverOpenAIModels(config: AIJudgeConfig): Promise<ModelProfile[]> {
  const response = await fetch(`${openAIBase()}/models`, {
    headers: { Authorization: `Bearer ${openAIApiKey()}` },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`/models ${response.status}`);
  }

  const data = (await response.json()) as { data?: OpenAIModel[] };
  const hints = config.visionHints.map(hint => hint.toLowerCase());

  return (data.data ?? []).map(model => ({
    id: model.id,
    provider: 'openai' as const,
    ownedBy: model.owned_by,
    supportsVision: hints.some(hint => model.id.toLowerCase().includes(hint)),
  }));
}
