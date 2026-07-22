import type { AIJudgeConfig } from '../../config/aiJudge.config.js';

import type { ComplexityResult, JudgeInput } from '../types.js';

/** Domains where a wrong verdict is costly — nudges the call toward a stronger tier. */
const SENSITIVE_DOMAIN = /\b(legal|medical|financial|hipaa|gdpr|diagnos|prescrib|invest|tax)\b/i;

/** Strong obligation words; three or more signals a multi-criteria rubric worth careful grading. */
const STRONG_CRITERIA = /\b(must|should|never|always|required?)\b/gi;

/**
 * Score a judging call's difficulty from its input and map it to a tier. Signals and weights are
 * configurable (aiJudgeConfig.complexity). `needsVision` is a hard requirement (an image was
 * supplied), not a soft signal, and is surfaced separately so the router can enforce it.
 */
export function analyzeComplexity(input: JudgeInput, config: AIJudgeConfig): ComplexityResult {
  const { weights, thresholds, tierCutoffs } = config.complexity;
  const rubric = input.rubric ?? '';
  const botResponse = input.botResponse ?? '';
  const reasons: string[] = [];
  let score = 0;

  if (rubric.length > thresholds.rubricChars) {
    score += weights.longRubric;
    reasons.push(`rubric > ${thresholds.rubricChars} chars`);
  }

  const criteria = (rubric.match(STRONG_CRITERIA) ?? []).length;
  if (criteria >= 3) {
    score += weights.multiCriteria;
    reasons.push(`${criteria} strong criteria`);
  }

  if (botResponse.length > thresholds.responseChars) {
    score += weights.longResponse;
    reasons.push(`response > ${thresholds.responseChars} chars`);
  }

  // An image or a reference image both require a vision-capable model; a reference means a compare.
  const needsVision = input.image !== undefined || input.referenceImage !== undefined;
  if (needsVision) {
    score += weights.image;
    reasons.push(input.referenceImage !== undefined ? 'image comparison' : 'image present');
  }

  if (SENSITIVE_DOMAIN.test(rubric) || SENSITIVE_DOMAIN.test(input.userMessage ?? '')) {
    score += weights.sensitiveDomain;
    reasons.push('sensitive domain');
  }

  const tier =
    score <= tierCutoffs.simpleMax
      ? 'simple'
      : score <= tierCutoffs.mediumMax
        ? 'medium'
        : 'complex';

  return { tier, score, needsVision, reasons };
}
