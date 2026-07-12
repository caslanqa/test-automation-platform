/**
 * Public type surface for the utils package. The AI Judge types are defined in ./ai/types and
 * re-exported here so existing `@utils/types` imports keep working; the table-driven test-case
 * helpers (ChatJudgeCase, JudgedCase) live here since they are test ergonomics, not judge internals.
 */
import type { JudgeVerdict } from './ai/types';

export type {
  ChatCompletionResponse,
  ComplexityResult,
  JudgeInput,
  JudgeMeta,
  JudgeVerdict,
  ModelProfile,
  ModelTier,
  ProviderKind,
  RegistrySnapshot,
  SelectionSource,
} from './ai/types';

/**
 * A single table-driven case for judging a chatbot response against a rubric.
 * Lets specs declare many scenarios as data and loop over them instead of
 * copy-pasting near-identical test bodies.
 * @example
 * <code>
 * const cases: ChatJudgeCase[] = [
 *   { name: 'greeting', userMessage: '', rubric: 'Bot greets the user.' },
 *   { name: 'no hours', userMessage: 'When do you open?', rubric: 'States 9am.', expectPass: false },
 * ];
 * for (const c of cases) {
 *   test(c.name, async () => { ... });
 * }
 * </code>
 */
export interface ChatJudgeCase {
  /** Human-readable case name, used as the test title. */
  name: string;
  /** The message sent to the chatbot ('' when the bot speaks first, e.g. a greeting). */
  userMessage: string;
  /** Plain-language criteria the bot response must satisfy. */
  rubric: string;
  /** Expected judge outcome. Defaults to true (the case should pass) when omitted. */
  expectPass?: boolean;
}

/** A judged case: the input case paired with the verdict the judge returned. */
export interface JudgedCase {
  case: ChatJudgeCase;
  verdict: JudgeVerdict;
}
