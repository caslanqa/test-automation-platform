/**
 * The escalation tier, and the four rules a model can never talk its way past.
 *
 * A model is asked exactly one question — *which of these five classes is this?* — and only when the
 * deterministic classifier already answered `unknown`. Everything that constrains the answer is here,
 * in code, because **a prompt is not a security boundary**: the material being classified includes the
 * tested page's own text, and that text is in the prompt.
 *
 * | Rule | Where it lives |
 * |---|---|
 * | A deterministic class other than `unknown` is never overridden | {@link applyEscalation} |
 * | An answer outside the deterministic candidate set is discarded | {@link applyEscalation} |
 * | Confidence is capped at 84, below the act band | {@link applyEscalation} |
 * | A split panel yields `unknown` | `vote.ts` |
 *
 * Together they mean **an LLM in this system can never authorise a code change.** The third rule is the
 * one that makes that literal: 85 is the floor for acting, and no escalated reading can reach it.
 *
 * @example
 * const escalated = await escalate({ projectDir, finding, triage });
 * applyEscalation(triage, escalated).confidence <= 84; // always
 */
import { createHash } from 'node:crypto';

import { candidateClasses, type Triage, type TriageClass } from '../triage/classify.js';
import type { Finding } from '../triage/run.js';
import { cacheKey, readCached, writeCached } from './cache.js';
import { askModel, loadJudgeKit, resolveJury, resolveModel, resolveSamples } from './client.js';
import {
  buildSystemPrompt,
  buildUserText,
  createNonce,
  type TrustedEvidence,
  type UntrustedEvidence,
} from './prompt.js';
import { majorityClass, type PanelResult } from './vote.js';

/** The ceiling an escalated reading may reach. One below the act band, deliberately. */
export const MAX_ESCALATED_CONFIDENCE = 84;

export interface EscalationRecord {
  /** What the panel concluded, before the invariant is applied. */
  panel: PanelResult;
  models: string[];
  /** Reasoning from a model on the winning side, for the human reading the report. */
  reasoning?: string;
  cached: boolean;
  /** Anything that stopped a call, named rather than swallowed. */
  problems: string[];
}

export interface EscalateOptions {
  projectDir: string;
  finding: Finding;
  /** Overrides `HEAL_MODEL` / `JUDGE_MODEL`. */
  model?: string;
  /** Overrides `HEAL_JURY`. */
  jury?: string;
}

/** Split the evidence into what we computed and what the page produced. The split IS the boundary. */
function evidenceFor(finding: Finding): {
  trusted: TrustedEvidence;
  untrusted: UntrustedEvidence;
} {
  const { test, failure, triage, history, diff } = finding;
  return {
    trusted: {
      deterministic: {
        class: triage.class,
        confidence: triage.confidence,
        reasons: triage.reasons,
      },
      candidates: candidateClasses(triage),
      outcome: test.outcome,
      history:
        history === undefined || history.runs === 0
          ? undefined
          : {
              runs: history.runs,
              flakeRate: history.flakeRate,
              recoveryRate: history.recoveryRate,
            },
      diff,
      hadGlobalErrors: triage.reasons.some(reason => reason.includes('outside any test')),
    },
    untrusted: {
      title: test.titlePath.join(' › '),
      kind: failure?.kind,
      matcher: failure?.matcher,
      locatorCode: failure?.locatorCode,
      expected: failure?.expected,
      received: failure?.received,
      message: failure?.message,
      callLog: failure?.callLog,
    },
  };
}

/**
 * Ask the configured model or panel. Returns undefined when nothing is configured, which is the default
 * state and must cost nothing: no import, no network, no message per failure.
 */
export async function escalate(options: EscalateOptions): Promise<EscalationRecord | undefined> {
  const jury = resolveJury(options.jury);
  const single = resolveModel(options.model);
  const models = jury.length > 0 ? jury : single === undefined ? [] : [single];
  if (models.length === 0) {
    return undefined;
  }

  const kit = await loadJudgeKit();
  if (kit === undefined) {
    return undefined;
  }

  const { trusted, untrusted } = evidenceFor(options.finding);
  const nonce = createNonce();
  const systemPrompt = buildSystemPrompt(nonce);
  const userText = buildUserText(trusted, untrusted, nonce);
  // The cache key must not contain the nonce (it changes every call and would sink every hit), so the
  // evidence is hashed from the material rather than from the composed text.
  const evidence = createHash('sha256')
    .update(JSON.stringify([trusted, untrusted]))
    .digest('hex');
  const site = options.finding.failure?.siteFingerprint ?? '';
  const samples = resolveSamples();

  const problems: string[] = [];
  const ballots: TriageClass[] = [];
  const reasons: Array<{ class: TriageClass; reasoning: string }> = [];
  let allCached = true;

  // Concurrent, for the reason the judge's panel is: the models do not depend on each other, and a
  // serial panel makes a three-model call three times as slow for nothing.
  const asked = await Promise.all(
    models.flatMap(model =>
      Array.from({ length: samples }, async (_unused, sample) => {
        const key = cacheKey({ model, siteFingerprint: site, evidence, sample });
        const hit = readCached(options.projectDir, key);
        if (hit !== undefined) {
          return { model, reply: hit, cached: true, problem: undefined };
        }
        const result = await askModel(kit, model, systemPrompt, userText);
        if (result.problem === undefined) {
          writeCached(options.projectDir, key, result.reply);
        }
        return { model, reply: result.reply, cached: false, problem: result.problem };
      }),
    ),
  );

  for (const answer of asked) {
    if (answer.problem !== undefined) {
      problems.push(`${answer.model}: ${answer.problem}`);
      // A failed call is not a vote. Counting it as `unknown` would let one unreachable endpoint
      // manufacture the tie that suppresses a real majority.
      continue;
    }
    allCached = allCached && answer.cached;
    ballots.push(answer.reply.class);
    reasons.push({ class: answer.reply.class, reasoning: answer.reply.reasoning });
  }

  const panel = majorityClass(ballots);
  return {
    panel,
    models,
    reasoning: reasons.find(entry => entry.class === panel.class)?.reasoning,
    cached: ballots.length > 0 && allCached,
    problems,
  };
}

/**
 * Fold an escalated reading into a deterministic one, under the invariant.
 *
 * Pure and synchronous, so the rule is unit-testable without a model — which is the point. A safety
 * property asserted in prose is a hope; this one is a function with a test that tries to break it.
 */
export function applyEscalation(triage: Triage, escalated: EscalationRecord | undefined): Triage {
  if (escalated === undefined) {
    return triage;
  }
  const notes = [
    `escalated to ${escalated.models.join(', ')}: ${escalated.panel.class}${
      escalated.panel.votes > 1
        ? ` (${escalated.panel.votes} votes, agreement ${escalated.panel.agreement.toFixed(2)})`
        : ''
    }${escalated.cached ? ', cached' : ''}`,
    ...(escalated.reasoning === undefined || escalated.reasoning === ''
      ? []
      : [`model reasoning: ${escalated.reasoning}`]),
    ...escalated.problems.map(problem => `escalation problem — ${problem}`),
  ];

  // Rule 1: determinism is never overridden. A class we reached from observed facts is not up for a
  // second opinion; the model was asked because we had none.
  if (triage.class !== 'unknown') {
    return {
      ...triage,
      reasons: [
        ...triage.reasons,
        ...notes,
        'the deterministic class stands — escalation is advisory',
      ],
    };
  }

  // Rule 2: the answer must be one we already considered possible. A model reading a hostile page can
  // name any class; it cannot name one the evidence never supported.
  const accepted =
    escalated.panel.class !== 'unknown' && candidateClasses(triage).includes(escalated.panel.class)
      ? escalated.panel.class
      : 'unknown';
  if (accepted === 'unknown') {
    return {
      ...triage,
      reasons: [
        ...triage.reasons,
        ...notes,
        escalated.panel.class === 'unknown'
          ? 'the panel did not reach a class either'
          : `'${escalated.panel.class}' is outside the classes this evidence supports, so it was discarded`,
      ],
    };
  }

  // Rule 3: the ceiling. 85 is the floor for acting, so an escalated class can advise and never act.
  const confidence = Math.min(
    MAX_ESCALATED_CONFIDENCE,
    Math.max(triage.confidence, Math.round(escalated.panel.agreement * 100)),
  );
  return {
    ...triage,
    class: accepted,
    confidence,
    reasons: [
      ...triage.reasons,
      ...notes,
      `confidence is capped at ${MAX_ESCALATED_CONFIDENCE}: a model can advise, never authorise a change`,
    ],
    // A veto is a conclusion from evidence and survives; the escalated class does not remove one.
    vetoes: [...triage.vetoes, 'escalated: no autofix may act on a model-assigned class'],
  };
}
