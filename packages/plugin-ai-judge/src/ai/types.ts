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

/**
 * One atomic requirement read out of the rubric and graded on its own. A yes/no check per requirement
 * is what the score is computed from, and what makes a failure name the criterion that failed.
 * @example { criterion: 'States the store opens at 9am', met: false, why: 'said 6pm' }
 */
export interface Criterion {
  /** The requirement, as the judge restated it from the rubric. */
  criterion: string;
  /** Whether the material satisfies it. */
  met: boolean;
  /** Short evidence for the call. */
  why?: string;
}

/** Structured verdict returned by the judge model. */
export interface JudgeVerdict {
  /** Whether the bot response satisfies the rubric. */
  pass: boolean;
  /** Quality score 0-100 — the share of met criteria whenever the judge returned a checklist. */
  score: number;
  /** Short justification for the verdict. */
  reasoning: string;
  /** Per-requirement checklist, empty when the rubric holds nothing separable (or in compare mode). */
  criteria?: Criterion[];
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
  /** True when the verdict was replayed from `.judge/cache` instead of judged again. */
  cached?: boolean;
  /** How many judgements were combined (only when `samples`/`jury` asked for more than one). */
  votes?: number;
  /** Share of those votes that agreed with the reported verdict — 1 is unanimous. */
  agreement?: number;
}

/** One turn of a multi-turn exchange, for judging an answer in the context it was given in. */
export interface ConversationTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** Which question the judge is answering about the material. */
export type JudgeMode = 'rubric' | 'compare' | 'grounded';

/**
 * Input for a single judging call. Three modes:
 *  - RUBRIC mode: provide `rubric` (optionally with an `image` or a `referenceAnswer`); the material is
 *    judged against the text criteria.
 *  - COMPARE mode: provide `referenceImage` plus an `image`; the judge checks whether the actual image
 *    matches the expected reference (`rubric` becomes optional focusing guidance).
 *  - GROUNDED mode: provide `context`; every factual claim in the response must be supported by it.
 * At least one of `rubric` / `referenceImage` / `context` must be present.
 */
export interface JudgeInput {
  /** The message the user sent to the chatbot (optional; omit or '' when not relevant). */
  userMessage?: string;
  /** The chatbot response under test (optional; omit for image-only or compare judging). */
  botResponse?: string;
  /** Criteria the material must satisfy. Required in rubric mode; optional guidance in compare mode. */
  rubric?: string;
  /**
   * An answer that would satisfy the rubric, used as a reference for substance — not as text to match.
   * Grading against a known-good answer is markedly easier than grading in the abstract.
   * @example { rubric: 'States the opening time.', referenceAnswer: 'We open at 9am.' }
   */
  referenceAnswer?: string;
  /**
   * Source material the response must stay inside — retrieved documents, a knowledge-base article, the
   * page text. Turns the call into a grounding check: each factual claim becomes a criterion, met only
   * when this supports it. Treated as untrusted data, since in a RAG app it is.
   * @example { botResponse, context: retrievedChunks }
   */
  context?: string | string[];
  /**
   * The exchange leading up to the answer under test. The last assistant turn is the material when
   * `botResponse` is omitted, and the earlier turns are what the judge reads it against.
   * @example { conversation: [{ role: 'user', content: 'Any XL?' }, { role: 'assistant', content: 'Yes.' }], rubric }
   */
  conversation?: ConversationTurn[];
  /**
   * Explicit model override for this call (bypasses tier/auto selection). A missing local model
   * is a hard error here — naming a model means you want exactly that one.
   */
  model?: string;
  /** Manual tier override; resolved via aiJudgeConfig.tierModels then dynamic assignment. */
  tier?: ModelTier;
  /**
   * Judge this many times and take the majority — the answer to a judge that flips on borderline
   * material. Each sample is cached separately, so the cost is paid once. Default 1.
   * @example { samples: 3 }
   */
  samples?: number;
  /**
   * Judge with each of these models and take the majority. A panel of smaller models agrees with
   * humans better than one large judge and cannot share a single model's bias; combined with `samples`
   * it is one vote per model per sample. A local panel pays a model swap per vote.
   * @example { jury: ['local/qwen3.5:4b', 'local/llama3.1', 'anthropic/claude-opus-4-8'] }
   */
  jury?: string[];
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
