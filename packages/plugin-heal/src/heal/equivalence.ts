/**
 * Is the replacement the *same element*?
 *
 * This is the safety boundary of the whole engine. A locator that resolves and makes the assertion
 * pass has proved nothing: it may be pointing at a different element that happens to satisfy the
 * check, which converts a caught bug into a green test. So a candidate is only ever applied when the
 * *code itself* said enough about the element to check a replacement against.
 *
 * **A correction to the original design, which contradicted itself.** The plan called for a binary
 * "two independent signals or refuse", and in the same breath expected `locator('#login-button')` to
 * be auto-repaired into `getByRole('button', { name: 'Log in' })`. Those cannot both hold: a test-id
 * or CSS-id locator states exactly one thing, and nothing in the code says the element was a button
 * named "Log in". That replacement is a reasonable human guess, not a proof. The verdicts below are
 * graded so the engine can offer the guess without pretending it proved it.
 *
 * | Verdict | Meaning | Autofix |
 * |---|---|---|
 * | `proven` | ≥2 of the intent's signals match the candidate, it is unique, and any stated scope holds | eligible |
 * | `likely` | one signal matches, the candidate is unique, and that name is unique page-wide | advisory |
 * | `moved` | the signals match but the candidate sits outside the scope the locator stated | advisory |
 * | `refused` | nothing shared to check against, or not unique, or too fragile | never |
 *
 * **Known limit, stated rather than papered over.** The failing element is by definition absent from
 * the snapshot, so its own position cannot be compared with the candidate's — neighbourhood
 * invariance is only checkable when the *locator* stated a scope. A recorded baseline from green runs
 * would lift that, and is deliberately deferred: without it the engine refuses more often, which is
 * the safe direction.
 *
 * @example
 * proveEquivalence(intent, candidate, tree).verdict; // 'proven' | 'likely' | 'moved' | 'refused'
 */
import { flatten, landmarkPath, type AriaNode } from './ariaSnapshot.js';
import { normalizeName, type HealCandidate } from './candidates.js';
import type { LocatorIntent } from './intent.js';

export type EquivalenceVerdict = 'proven' | 'likely' | 'moved' | 'refused';

export interface Equivalence {
  verdict: EquivalenceVerdict;
  /** Which of the intent's signals the candidate matches. */
  matched: Array<'role' | 'name'>;
  /** How many elements the candidate resolves to in the snapshot. */
  uniqueMatches: number;
  /** The candidate's landmark chain, for the report. */
  landmarkPath: string[];
  /** Present on `moved`: the scope the locator stated, which the candidate is not inside. */
  outsideScope?: string;
  /** Why a refusal, or why a verdict is weaker than `proven`. */
  reasons: string[];
}

/** The minimum score a candidate must reach before it is worth proving anything about. */
export const MIN_CANDIDATE_SCORE = 60;

/**
 * The *kind* of container a structural scope named, e.g. `form` from `locator('form.signin')`.
 *
 * The class is what drifted, so it cannot be a constraint — but the tag is still a real statement
 * about where the element lives, and dropping it opens a hole this closes: with a name that repeats
 * across containers, the ranking can lead with the wrong one and role+name would then "prove" an
 * element the test never meant. Measured, not hypothesised: a page with a Continue button in both a
 * form and a dialog proved the dialog's.
 */
function structuralScopeRole(intent: LocatorIntent): string | undefined {
  for (const match of intent.code.matchAll(/(?:^|\.)locator\(\s*['"`]([^'"`]+)['"`]/g)) {
    const selector = match[1].trim();
    // A leading tag name, before any class, id, attribute or combinator.
    const tag = /^([a-z][a-z0-9-]*)(?=[.#[:\s>+~]|$)/.exec(selector)?.[1];
    if (
      tag !== undefined &&
      /\)\s*\.\s*(getBy|locator|filter)/.test(intent.code.slice(match.index))
    ) {
      return tag;
    }
  }
  return undefined;
}

/**
 * A scope the failing locator stated semantically: the outermost named role in its chain, when the
 * chain continues past it.
 */
function statedScope(intent: LocatorIntent): { role: string; name: string } | undefined {
  const match =
    /getByRole\(\s*['"`]([\w-]+)['"`][^)]*\bname\s*:\s*['"`]((?:[^'"`\\]|\\.)*)['"`]/.exec(
      intent.code,
    );
  if (match === null) {
    return undefined;
  }
  // Only a scope: the chain must continue past it, otherwise this IS the failing locator.
  const after = intent.code.slice(match.index + match[0].length);
  return /\)\s*\.\s*(getBy|locator|filter|first|last|nth)/.test(after)
    ? { role: match[1], name: match[2].replace(/\\(.)/g, '$1') }
    : undefined;
}

const inScope = (node: AriaNode, scope: { role: string; name: string }): boolean =>
  node.path.some(
    ancestor =>
      ancestor.role === scope.role &&
      ancestor.name !== undefined &&
      normalizeName(ancestor.name) === normalizeName(scope.name),
  );

export function proveEquivalence(
  intent: LocatorIntent,
  candidate: HealCandidate,
  tree: readonly AriaNode[],
): Equivalence {
  const reasons: string[] = [];
  const matched: Equivalence['matched'] = [];
  const path = landmarkPath(candidate.node);

  const refuse = (reason: string): Equivalence => ({
    verdict: 'refused',
    matched,
    uniqueMatches: candidate.unique ? 1 : 0,
    landmarkPath: path,
    reasons: [...reasons, reason],
  });

  if (!candidate.unique) {
    return refuse('not-unique: the replacement matches more than one element');
  }
  if (candidate.score < MIN_CANDIDATE_SCORE) {
    return refuse(
      `too-fragile: the best replacement scores ${candidate.score}, below the ${MIN_CANDIDATE_SCORE} floor`,
    );
  }

  // Which of the things the code said about the element does the candidate still satisfy?
  if (intent.role !== undefined && intent.role === candidate.node.role) {
    matched.push('role');
  }
  const candidateName = candidate.node.name ?? candidate.node.text;
  if (
    intent.name !== undefined &&
    candidateName !== undefined &&
    normalizeName(intent.name) === normalizeName(candidateName)
  ) {
    matched.push('name');
  }

  if (matched.length === 0) {
    return refuse(
      intent.testId !== undefined || intent.cssId !== undefined
        ? 'no-shared-signal: the locator only stated an identifier, and that identifier is gone — nothing in the code says which element this was'
        : 'no-shared-signal: the locator stated nothing the replacement can be checked against',
    );
  }

  // A structural scope constrains the KIND of container, which is enough to catch the wrong one.
  const structural = structuralScopeRole(intent);
  if (
    structural !== undefined &&
    !candidate.node.path.some(ancestor => ancestor.role === structural)
  ) {
    return {
      verdict: 'moved',
      matched,
      uniqueMatches: 1,
      landmarkPath: path,
      outsideScope: structural,
      reasons: [
        ...reasons,
        `the locator was scoped to a <${structural}> and the replacement is not inside one — it may be a different element with the same name`,
      ],
    };
  }

  const scope = statedScope(intent);
  if (scope !== undefined && !inScope(candidate.node, scope)) {
    return {
      verdict: 'moved',
      matched,
      uniqueMatches: 1,
      landmarkPath: path,
      outsideScope: `${scope.role} "${scope.name}"`,
      reasons: [
        ...reasons,
        `the replacement is outside the ${scope.role} "${scope.name}" this locator was scoped to — usually an intended redesign, which a human should confirm`,
      ],
    };
  }

  if (matched.length >= 2) {
    return {
      verdict: 'proven',
      matched,
      uniqueMatches: 1,
      landmarkPath: path,
      reasons: [
        `${matched.join(' and ')} match what the locator stated, and the replacement is unique`,
      ],
    };
  }

  // One signal. A name that is unique across the whole page is a strong identifier on its own; a name
  // that repeats is not, and neither is a bare role.
  const all = flatten(tree);
  const nameIsPageUnique =
    matched[0] === 'name' &&
    candidateName !== undefined &&
    all.filter(
      node =>
        (node.name !== undefined && normalizeName(node.name) === normalizeName(candidateName)) ||
        (node.text !== undefined && normalizeName(node.text) === normalizeName(candidateName)),
    ).length === 1;

  if (nameIsPageUnique) {
    return {
      verdict: 'likely',
      matched,
      uniqueMatches: 1,
      landmarkPath: path,
      reasons: [
        `only the name matches, but no other element on the page carries it — strong, though not proof`,
      ],
    };
  }

  return refuse(
    `one-signal: only ${matched[0]} matches, which is not enough to show this is the same element`,
  );
}

/** Autofix is only ever eligible for a proven equivalence. */
export const eligibleForAutofix = (equivalence: Equivalence): boolean =>
  equivalence.verdict === 'proven';
