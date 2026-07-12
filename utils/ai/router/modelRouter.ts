import type { AIJudgeConfig } from '@config/aiJudge.config';

import { ollamaProvider } from '../providers/ollamaProvider';
import { openAIProvider } from '../providers/openAIProvider';
import { type AIProvider, JudgeHttpError } from '../providers/provider';
import type {
  ComplexityResult,
  JudgeInput,
  JudgeMeta,
  ModelProfile,
  ModelTier,
  ProviderKind,
  RegistrySnapshot,
  SelectionSource,
} from '../types';

/** Prefixes that route to the local Ollama backend; everything else is the 9Router gateway. */
const OLLAMA_PREFIXES = ['local/'];

/** An ordered list of models to try for one judging call, plus the trace of how it was chosen. */
export interface SelectionPlan {
  /** Candidates to attempt in order (usually 1; several when cloud fallback applies). */
  candidates: ModelProfile[];
  /** Diagnostic trace; `selectedModel` is filled by the caller once a candidate succeeds. */
  meta: JudgeMeta;
}

/** Classify a routable model id to its backend by prefix. */
function providerOf(modelId: string): ProviderKind {
  return OLLAMA_PREFIXES.some(prefix => modelId.startsWith(prefix)) ? 'ollama' : 'openai';
}

/** The concrete AIProvider for a model profile. */
export function getProvider(model: ModelProfile): AIProvider {
  return model.provider === 'ollama' ? ollamaProvider : openAIProvider;
}

/** Convert a routable id to the backend-native model string (strip the `local/` prefix for Ollama). */
export function toApiModel(model: ModelProfile): string {
  return model.provider === 'ollama' && model.id.startsWith('local/')
    ? model.id.slice('local/'.length)
    : model.id;
}

/** Only auth/availability failures are worth trying the next cloud candidate for. */
export function isRetryable(error: unknown): boolean {
  return error instanceof JudgeHttpError && [401, 403, 404].includes(error.status);
}

/** Synthesize a profile for a cloud model id not present in (or not yet discovered by) the registry. */
function synthCloudProfile(modelId: string, config: AIJudgeConfig): ModelProfile {
  const lower = modelId.toLowerCase();
  return {
    id: modelId,
    provider: 'openai',
    supportsVision: config.visionHints.some(hint => lower.includes(hint.toLowerCase())),
  };
}

/** Best-effort "did you mean" for a local model that is not installed. */
function nearestInstalled(name: string, installed: string[]): string | undefined {
  const family = name.split(':')[0];
  return (
    installed.find(candidate => candidate.split(':')[0] === family) ??
    installed.find(candidate => candidate.startsWith(family.slice(0, 4)))
  );
}

/** Error for an explicitly-named local model that is not installed (with a suggestion). */
function notInstalledError(modelId: string, registry: RegistrySnapshot): Error {
  const name = modelId.replace(/^local\//, '');
  const installed = registry.models
    .filter(model => model.provider === 'ollama')
    .map(model => model.id.replace(/^local\//, ''));
  const suggestion = nearestInstalled(name, installed);

  const parts = [
    `[ai-judge] model '${modelId}' is not installed in Ollama.`,
    `Installed: ${installed.length > 0 ? installed.join(', ') : '(none)'}.`,
  ];
  if (suggestion !== undefined) {
    parts.push(`Did you mean 'local/${suggestion}'?`);
  }

  return new Error(parts.join(' '));
}

/**
 * Resolve an explicitly-named model (input.model or JUDGE_MODEL) to a single candidate. A named
 * model means "exactly this" — a missing LOCAL model is a hard error (they are cheaply enumerable,
 * so a miss is a typo or an un-pulled model). A cloud id is attempted even if absent from the
 * registry, since the gateway may be stale/unreachable but the key still valid.
 */
function resolveExplicit(
  modelId: string,
  registry: RegistrySnapshot,
  config: AIJudgeConfig
): ModelProfile {
  const found = registry.models.find(model => model.id === modelId);
  if (found !== undefined) {
    return found;
  }
  if (providerOf(modelId) === 'ollama') {
    throw notInstalledError(modelId, registry);
  }

  return synthCloudProfile(modelId, config);
}

/** Rank a cloud model id against the preference list: lower index wins, unmatched sinks to the end. */
function preferenceRank(modelId: string, prefer: string[]): number {
  const lower = modelId.toLowerCase();
  const index = prefer.findIndex(pref => lower.includes(pref.toLowerCase()));
  return index === -1 ? prefer.length : index;
}

/**
 * Cloud fallback candidates, discovered (never hardcoded) and ordered by preference. Provider-
 * agnostic across whatever the gateway serves. Vision-filtered when required. `exclude` drops an
 * id already placed ahead (e.g. a pinned cloud model).
 */
function cloudFallback(
  needsVision: boolean,
  registry: RegistrySnapshot,
  config: AIJudgeConfig,
  exclude?: string
): ModelProfile[] {
  let cloud = registry.models.filter(model => model.provider === 'openai' && model.id !== exclude);
  if (needsVision) {
    cloud = cloud.filter(model => model.supportsVision);
  }

  return [...cloud].sort(
    (a, b) =>
      preferenceRank(a.id, config.cloudFallbackPrefer) -
      preferenceRank(b.id, config.cloudFallbackPrefer)
  );
}

/**
 * Dynamically assign a tier to an installed local model by ranking on parameter size:
 * simple → smallest, complex → largest, medium → median. Vision-filtered when required. Returns
 * null when no compatible local model exists (caller then falls back to cloud).
 */
function dynamicLocal(
  tier: ModelTier,
  needsVision: boolean,
  registry: RegistrySnapshot
): ModelProfile | null {
  let locals = registry.models.filter(model => model.provider === 'ollama');
  if (needsVision) {
    locals = locals.filter(model => model.supportsVision);
  }
  if (locals.length === 0) {
    return null;
  }

  const ranked = [...locals].sort((a, b) => (a.paramsB ?? 0) - (b.paramsB ?? 0));
  const index =
    tier === 'simple'
      ? 0
      : tier === 'complex'
        ? ranked.length - 1
        : Math.floor((ranked.length - 1) / 2);

  return ranked[index];
}

/**
 * Resolve a tier to an ordered candidate list via the degradation ladder:
 *   1. config pin — local (if installed & compatible) or cloud (attempted, with cloud fallbacks after)
 *   2. dynamic local — installed model by size bucket
 *   3. cloud fallback — when no compatible local model exists
 * Returns [] when nothing is usable; the caller turns that into an actionable error.
 */
function resolveTier(
  tier: ModelTier,
  needsVision: boolean,
  registry: RegistrySnapshot,
  config: AIJudgeConfig
): ModelProfile[] {
  const pin = config.tierModels[tier];
  if (pin !== undefined) {
    if (providerOf(pin) === 'ollama') {
      const installed = registry.models.find(model => model.id === pin);
      if (installed !== undefined && (!needsVision || installed.supportsVision)) {
        return [installed];
      }
      // Pinned local model missing or not vision-capable → fall through to dynamic.
    } else {
      return [synthCloudProfile(pin, config), ...cloudFallback(needsVision, registry, config, pin)];
    }
  }

  const local = dynamicLocal(tier, needsVision, registry);
  if (local !== null) {
    return [local];
  }

  return cloudFallback(needsVision, registry, config);
}

/** Base trace shared by every branch; `selectedModel` is filled once a candidate succeeds. */
function baseMeta(
  complexity: ComplexityResult,
  tier: JudgeMeta['tier'],
  source: SelectionSource
): JudgeMeta {
  return {
    selectedModel: '',
    tier,
    score: complexity.score,
    needsVision: complexity.needsVision,
    reasons: complexity.reasons,
    source,
  };
}

/**
 * Build the selection plan for a judging call. Precedence:
 *   1. input.model            — explicit, exactly that model, no fallback
 *   2. env JUDGE_MODEL        — explicit global pin, no fallback (unless input.tier is set)
 *   3. input.tier / auto tier — dynamic ladder (local → cloud fallback)
 */
export function planSelection(
  input: JudgeInput,
  complexity: ComplexityResult,
  registry: RegistrySnapshot,
  config: AIJudgeConfig
): SelectionPlan {
  if (input.model !== undefined) {
    return {
      candidates: [resolveExplicit(input.model, registry, config)],
      meta: baseMeta(complexity, 'explicit', 'input.model'),
    };
  }

  const envPin = process.env.JUDGE_MODEL;
  if (input.tier === undefined && envPin !== undefined && envPin.length > 0) {
    return {
      candidates: [resolveExplicit(envPin, registry, config)],
      meta: baseMeta(complexity, 'explicit', 'env.JUDGE_MODEL'),
    };
  }

  const tier = input.tier ?? complexity.tier;
  const source: SelectionSource = input.tier !== undefined ? 'input.tier' : 'auto';

  return {
    candidates: resolveTier(tier, complexity.needsVision, registry, config),
    meta: baseMeta(complexity, tier, source),
  };
}

/** Build the actionable "nothing usable" error when every candidate is unavailable. */
export function noModelError(
  tier: JudgeMeta['tier'],
  needsVision: boolean,
  registry: RegistrySnapshot,
  attempts: Array<{ id: string; error: string }>
): Error {
  const locals = registry.models.filter(model => model.provider === 'ollama');
  const visionLocals = locals.filter(model => model.supportsVision);
  const cloudError = registry.errors.find(entry => entry.startsWith('9Router'));

  const lines = [
    `[ai-judge] No usable judge model for tier '${tier}'${needsVision ? ' (vision required)' : ''}.`,
    `  • Local (Ollama): ${locals.length} model(s)${needsVision ? `, ${visionLocals.length} vision-capable` : ''}`,
  ];

  if (attempts.length > 0) {
    lines.push(
      `  • Cloud (9Router): tried ${attempts.map(attempt => `${attempt.id} (${attempt.error})`).join(', ')}`
    );
  } else if (cloudError !== undefined) {
    lines.push(`  • Cloud (9Router): ${cloudError}`);
  } else {
    lines.push('  • Cloud (9Router): no candidate models');
  }

  lines.push(
    '  Fix: pull a local model (e.g. `ollama pull qwen3.5`) or set JUDGE_API_KEY for cloud fallback.'
  );

  return new Error(lines.join('\n'));
}
