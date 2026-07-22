/**
 * Shared types for the AI Judge subsystem. These are the single source of truth; utils/types.ts
 * re-exports the public ones so existing `@utils/types` imports keep working.
 */

/** Capability/quality tier a judging call needs, derived from input complexity. */
export type ModelTier = 'simple' | 'medium' | 'complex';

/** Which backend a model is reached through. Built-ins plus any custom kind via registerProvider. */
export type ProviderKind = 'ollama' | 'openai' | 'anthropic' | (string & {});

/** How the concrete model for a call was chosen (for the diagnostic trace). */
export type SelectionSource = 'input.model' | 'input.tier' | 'env.JUDGE_MODEL' | 'auto';

/** Structured verdict returned by the judge model. */
export interface JudgeVerdict {
  /** Whether the bot response satisfies the rubric. */
  pass: boolean;
  /** Quality score 0-100. */
  score: number;
  /** Short justification for the verdict. */
  reasoning: string;
  /** Routing trace, attached only when JudgeInput.verbose is set. */
  _meta?: JudgeMeta;
}

/** Diagnostic trace of how a model was chosen for a judging call. */
export interface JudgeMeta {
  /** The model id that actually produced the verdict (e.g. 'local/qwen3.5:latest'). */
  selectedModel: string;
  /** The tier that drove selection, or 'explicit' when a model was named directly. */
  tier: ModelTier | 'explicit';
  /** Complexity score that produced the tier. */
  score: number;
  /** Whether the call required a vision-capable model (an image was supplied). */
  needsVision: boolean;
  /** Human-readable complexity signals that fired (for debugging surprising verdicts). */
  reasons: string[];
  /** Which precedence branch selected the model. */
  source: SelectionSource;
}

/**
 * Input for a single judging call. Two modes:
 *  - RUBRIC mode: provide `rubric` (optionally with an `image`); the material is judged against the
 *    text criteria.
 *  - COMPARE mode: provide `referenceImage` plus an `image`; the judge checks whether the actual
 *    image matches the expected reference (`rubric` becomes optional focusing guidance).
 * At least one of `rubric` / `referenceImage` must be present.
 */
export interface JudgeInput {
  /** The message the user sent to the chatbot (optional; omit or '' when not relevant). */
  userMessage?: string;
  /** The chatbot response under test (optional; omit for image-only or compare judging). */
  botResponse?: string;
  /** Criteria the material must satisfy. Required in rubric mode; optional guidance in compare mode. */
  rubric?: string;
  /**
   * Explicit model override for this call (bypasses tier/auto selection). A missing local model
   * is a hard error here — naming a model means you want exactly that one.
   */
  model?: string;
  /** Manual tier override; resolved via aiJudgeConfig.tierModels then dynamic assignment. */
  tier?: ModelTier;
  /**
   * Image to evaluate (multimodal judging) or, in compare mode, the ACTUAL image. Accepts a
   * Playwright screenshot Buffer, a data URI ("data:image/png;base64,..."), or a file path. Forces
   * selection of a vision-capable model.
   */
  image?: string | Buffer;
  /**
   * EXPECTED reference image for compare mode. When set, the judge compares `image` (actual) against
   * this reference. Same accepted formats as `image`.
   */
  referenceImage?: string | Buffer;
  /** When true, attach the routing trace to the verdict as `_meta`. */
  verbose?: boolean;
}

/** Minimal shape of the OpenAI-compatible chat completion response we consume. */
export interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * A model discovered from a provider, normalized across Ollama and the 9Router gateway. Ollama
 * reports rich metadata (vision capability, parameter size); the gateway reports only id + owner,
 * so `supportsVision` for cloud models is inferred from the id via aiJudgeConfig.visionHints.
 */
export interface ModelProfile {
  /** Routable id including prefix, e.g. 'local/qwen3.5:latest' or 'gh/claude-sonnet-4.6'. */
  id: string;
  /** Backend used to reach the model. */
  provider: ProviderKind;
  /** Owner as reported by the gateway (9Router /models `owned_by`); undefined for Ollama. */
  ownedBy?: string;
  /** Whether the model can evaluate images. */
  supportsVision: boolean;
  /** Parameter size in billions, when known (Ollama exposes it; the gateway does not). */
  paramsB?: number;
  /** Context window in tokens, when known. */
  contextWindow?: number;
}

/** A cached view of every model discovered across providers. */
export interface RegistrySnapshot {
  /** All models found across reachable providers. */
  models: ModelProfile[];
  /** Epoch ms when this snapshot was built (for cache-TTL checks). */
  fetchedAt: number;
  /** Per-provider discovery failures (e.g. "Ollama: fetch failed", "9Router: /models 401"). */
  errors: string[];
}

/** Result of analyzing a JudgeInput's complexity. */
export interface ComplexityResult {
  /** Tier the score maps to. */
  tier: ModelTier;
  /** Total complexity score. */
  score: number;
  /** Whether an image was supplied (a hard vision requirement). */
  needsVision: boolean;
  /** Signals that contributed to the score. */
  reasons: string[];
}
