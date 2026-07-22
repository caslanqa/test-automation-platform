import { ollamaApiBase } from '../providers/ollamaProvider.js';
import type { ModelProfile } from '../types.js';

/** Discovery HTTP timeout — a down service must fail fast, not hang the first judge call. */
const DISCOVERY_TIMEOUT_MS = 4000;

/** Subset of an Ollama /api/tags model entry we rely on. */
interface OllamaTag {
  name: string;
  capabilities?: string[];
  details?: { parameter_size?: string; context_length?: number };
}

/**
 * Parse Ollama's `parameter_size` ("4.7B", "36.0B", "700M") into billions of params, so models
 * can be size-ranked for dynamic tier assignment. Unknown/odd formats return undefined.
 */
function parseParams(size?: string): number | undefined {
  if (size === undefined) {
    return undefined;
  }
  const match = /([\d.]+)\s*([BM])/i.exec(size);
  if (match === null) {
    return undefined;
  }
  const value = parseFloat(match[1]);
  return match[2].toUpperCase() === 'M' ? value / 1000 : value;
}

/**
 * Discover locally-installed Ollama models. Ollama exposes rich metadata: `capabilities` (which
 * includes "vision") and `details.parameter_size`, so both vision support and size ranking come
 * from real data — no hardcoded model list. Ids are prefixed `local/` to stay routable.
 */
export async function discoverOllamaModels(): Promise<ModelProfile[]> {
  const response = await fetch(`${ollamaApiBase()}/api/tags`, {
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`/api/tags ${response.status}`);
  }

  const data = (await response.json()) as { models?: OllamaTag[] };

  return (data.models ?? []).map(model => ({
    id: `local/${model.name}`,
    provider: 'ollama' as const,
    supportsVision: (model.capabilities ?? []).includes('vision'),
    paramsB: parseParams(model.details?.parameter_size),
    contextWindow: model.details?.context_length,
  }));
}
