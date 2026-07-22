import type { ModelTier } from '../ai/types.js';

/**
 * AI Judge routing configuration.
 *
 * This is cross-cutting POLICY — not environment- or credential-specific — so it lives here as a
 * typed module rather than in env/environments.json. Two reasons: (1) loadEnv only flattens string
 * scalars into process.env, so a nested object like `tierModels` would be silently dropped; and
 * (2) tier mapping / thresholds are identical across dev/staging/prod. Connection + credential
 * settings (JUDGE_GATEWAY_BASE_URL, JUDGE_OLLAMA_BASE_URL, JUDGE_API_KEY, JUDGE_MODEL, KEEP_ALIVE) stay in
 * environments.json because they genuinely vary by environment.
 *
 * Model selection is DISCOVERY-FIRST: concrete model ids are resolved at runtime from whatever
 * Ollama and the 9Router gateway actually serve. Everything below expresses PREFERENCES and
 * thresholds only — nothing here assumes a specific model exists on a given machine.
 */
export interface AIJudgeConfig {
  /**
   * Optional per-tier model pins. Leave a tier unset to let the router assign it dynamically from
   * the installed Ollama models (ranked by parameter size). A pinned `local/…` model is used only
   * if actually installed and compatible; otherwise the router falls back to dynamic selection. A
   * pinned non-local model (e.g. `gh/…`) routes to the 9Router gateway.
   * @example { complex: 'gh/claude-sonnet-4.6' } // force the hardest evaluations onto cloud
   */
  tierModels: Partial<Record<ModelTier, string>>;

  /** Complexity scoring that maps a JudgeInput to a tier. */
  complexity: {
    /** Points added per signal. */
    weights: {
      longRubric: number;
      multiCriteria: number;
      longResponse: number;
      image: number;
      sensitiveDomain: number;
    };
    /** Character thresholds for the length-based signals. */
    thresholds: { rubricChars: number; responseChars: number };
    /** score <= simpleMax → 'simple'; <= mediumMax → 'medium'; otherwise 'complex'. */
    tierCutoffs: { simpleMax: number; mediumMax: number };
  };

  /**
   * Name substrings treated as vision-capable on the CLOUD side. The 9Router /models endpoint does
   * not report capabilities, so vision support is inferred from the model id. (Ollama reports it
   * natively via /api/tags, so this list is never consulted for local models.)
   */
  visionHints: string[];

  /**
   * Cloud fallback PREFERENCE by name substring (not a fixed id). When no compatible local model
   * exists, the router discovers the live 9Router model list and tries models whose id matches an
   * entry here, in order, advancing to the next on an auth/availability error. Provider-agnostic:
   * 'sonnet' matches gh/claude-sonnet-4.6 or anthropic/claude-3.5-sonnet alike. Empty → any
   * available model (vision-capable first when an image is judged).
   */
  cloudFallbackPrefer: string[];

  /** Discovery cache time-to-live in milliseconds. */
  registryCacheTtlMs: number;
}

/**
 * Default AI Judge configuration. Override by editing this file.
 *
 * Ships DYNAMIC by default (`tierModels: {}`): the router assigns tiers from whatever Ollama has
 * installed, so the framework adapts to any machine instead of pointing at a model that may not
 * exist. Pin a tier to take manual control, e.g. `complex: 'gh/claude-sonnet-4.6'`.
 */
export const aiJudgeConfig: AIJudgeConfig = {
  tierModels: {},

  complexity: {
    weights: {
      longRubric: 2,
      multiCriteria: 2,
      longResponse: 1,
      image: 3,
      sensitiveDomain: 2,
    },
    thresholds: { rubricChars: 200, responseChars: 500 },
    tierCutoffs: { simpleMax: 2, mediumMax: 5 },
  },

  visionHints: ['claude', 'gemini', 'gpt-4o', 'gpt-5', 'vision', 'llava'],

  cloudFallbackPrefer: ['opus', 'sonnet', 'gpt-5', 'gemini', 'gpt-4o', 'flash', 'mini'],

  registryCacheTtlMs: 5 * 60 * 1000,
};
