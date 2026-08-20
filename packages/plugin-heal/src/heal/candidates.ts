/**
 * Ranked replacement locators, generated from the ARIA snapshot Playwright captured at the failure.
 *
 * This copies the **policy** of `@pwtap/mobile-core`'s `locatorCandidates`, not its code: the same
 * 0-100 stability scale, the same −25 for a non-unique match, the same −10 for an index-disambiguating
 * fallback, and the same rule that a risky candidate says what makes it risky.
 * Importing the mobile module would put a mobile package in a web plugin's runtime closure for one
 * interface, and the strategy sets genuinely differ.
 *
 * The scale is not arbitrary. A locator's score is how likely it is to still resolve after a redesign,
 * and the ordering is the one the platform already teaches in `spec-conventions`: role and accessible
 * name survive restyling because they are what the user perceives; text survives until someone edits
 * the copy; structure survives nothing.
 *
 * `getByTestId` is deliberately **absent**: the snapshot cannot see a test id, and a drifted locator
 * has lost its identifier by definition, so there is none left to propose.
 *
 * @example
 * webLocatorCandidates(tree, parseLocatorIntent("locator('#login-button')"));
 * // → [{ code: "getByRole('button', { name: 'Log in' })", score: 85, unique: true, … }]
 */
import { flatten, landmarkPath, type AriaNode } from './ariaSnapshot.js';
import type { LocatorIntent } from './intent.js';

export type CandidateStrategy = 'role' | 'roleInLandmark' | 'placeholder' | 'text' | 'roleOrdinal';

export interface HealCandidate {
  strategy: CandidateStrategy;
  /** The replacement expression, ready to substitute into the spec. */
  code: string;
  /** 0-100. */
  score: number;
  confidence: 'high' | 'medium' | 'low';
  unique: boolean;
  warnings: string[];
  /** The node this candidate points at, so equivalence can be checked against it. */
  node: AriaNode;
}

/** Base scores, in the platform's own order of preference. */
const BASE = {
  role: 85,
  roleInLandmark: 80,
  placeholder: 70,
  text: 58,
} as const;

const NOT_UNIQUE = 25;
const LONG_TEXT = 40;

const confidenceBand = (score: number): HealCandidate['confidence'] =>
  score >= 75 ? 'high' : score >= 45 ? 'medium' : 'low';

/** Single-quoted, with quotes and backslashes escaped — the repo's own code style. */
const quote = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * Trim, collapse whitespace, case-fold, and drop the trailing punctuation a label often carries.
 *
 * The final `trim()` is not redundant: `'Log In :'` loses the colon and would otherwise keep the
 * space that preceded it, so two names that differ only in that punctuation would stop matching.
 */
export const normalizeName = (name: string): string =>
  name
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[:*…]+$/, '')
    .trim()
    .toLowerCase();

const sameName = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && normalizeName(a) === normalizeName(b);

/** Nodes that would match `getByRole(role, { name })`. */
const matchingRole = (all: readonly AriaNode[], role: string, name?: string): AriaNode[] =>
  all.filter(node => node.role === role && (name === undefined || sameName(node.name, name)));

/**
 * Which nodes could be what the failing locator meant.
 *
 * With a name to go on, that is any node whose accessible name or text matches it — the identifier
 * changed, the name did not. With a role, every node of that role.
 *
 * With **neither** — a test-id or CSS-id locator whose identifier is gone — there is nothing to search
 * the snapshot with, and that is exactly the case a human answers instantly ("the button labelled Log
 * in") from knowledge the code does not contain. Returning nothing would be honest but useless, so the
 * addressable elements of the page are offered instead: a reviewer gets the list they would have
 * written out by hand, while {@link proveEquivalence} still refuses to claim any of them is the same
 * element. Suggesting is not proving, and the two must not be conflated.
 */
export function targetsFor(tree: readonly AriaNode[], intent: LocatorIntent): AriaNode[] {
  const all = flatten(tree);
  if (intent.name !== undefined && intent.name !== '') {
    const byName = all.filter(
      node => sameName(node.name, intent.name) || sameName(node.text, intent.name),
    );
    const byRole =
      intent.role === undefined ? byName : byName.filter(node => node.role === intent.role);
    return byRole.length > 0 ? byRole : byName;
  }
  if (intent.role !== undefined) {
    return matchingRole(all, intent.role);
  }
  // Addressable means it has an accessible name — an element a locator can name at all.
  return all.filter(node => node.name !== undefined && node.name !== '');
}

export interface CandidateOptions {
  /** Restrict to this node; otherwise every plausible target is offered. */
  target?: AriaNode;
}

export function webLocatorCandidates(
  tree: readonly AriaNode[],
  intent: LocatorIntent,
  options: CandidateOptions = {},
): HealCandidate[] {
  const all = flatten(tree);
  const targets = options.target === undefined ? targetsFor(tree, intent) : [options.target];
  const candidates: HealCandidate[] = [];

  const add = (
    strategy: CandidateStrategy,
    code: string,
    node: AriaNode,
    matches: readonly AriaNode[],
    baseScore: number,
    baseWarnings: string[] = [],
  ): void => {
    const warnings = [...baseWarnings];
    let score = baseScore;
    const unique = matches.length === 1;
    if (!unique) {
      score -= NOT_UNIQUE;
      warnings.push(`not unique — ${matches.length} elements match this locator`);
    }
    score = Math.max(0, Math.min(100, score));
    candidates.push({
      strategy,
      code,
      score,
      confidence: confidenceBand(score),
      unique,
      warnings,
      node,
    });

    // A repeated list row leaves every attribute non-unique, and pinning the ordinal is the only way
    // to reach one deterministically. It therefore outranks the plain candidate (−10 against −25),
    // which is the same arithmetic `mobile-core` uses and is the right way round: a locator matching
    // several elements resolves to whichever the driver returns first, and that is not a contract.
    // Both are still offered, and this one says what makes it fragile rather than looking solid.
    const ordinal = matches.indexOf(node);
    if (!unique && ordinal >= 0) {
      const ordinalScore = Math.max(0, Math.min(100, baseScore - 10));
      candidates.push({
        strategy: 'roleOrdinal',
        code: `${code}.nth(${ordinal})`,
        score: ordinalScore,
        confidence: confidenceBand(ordinalScore),
        // Exactly one element by construction: it selects among the matches rather than describing them.
        unique: true,
        warnings: [
          ...warnings.filter(warning => !warning.startsWith('not unique')),
          `position-dependent — matches ${matches.length} elements and takes number ${ordinal + 1}, so reordering or filtering changes what this resolves to`,
        ],
        node,
      });
    }
  };

  for (const node of targets) {
    const name = node.name;

    if (name !== undefined && name !== '') {
      add(
        'role',
        `getByRole(${quote(node.role)}, { name: ${quote(name)} })`,
        node,
        matchingRole(all, node.role, name),
        BASE.role,
      );

      // Scoping to the enclosing named landmark rescues a name that repeats across the page while
      // keeping both semantic signals — strictly better than an ordinal when one is available.
      const named = node.path.filter(
        ancestor => ancestor.name !== undefined && ancestor.name !== '',
      );
      const scope = named[named.length - 1];
      if (scope !== undefined && matchingRole(all, node.role, name).length > 1) {
        const withinScope = flatten([scope]).filter(
          candidate => candidate.role === node.role && sameName(candidate.name, name),
        );
        if (withinScope.length === 1) {
          add(
            'roleInLandmark',
            `getByRole(${quote(scope.role)}, { name: ${quote(scope.name as string)} })` +
              `.getByRole(${quote(node.role)}, { name: ${quote(name)} })`,
            node,
            withinScope,
            BASE.roleInLandmark,
          );
        }
      }
    }

    const placeholder = node.props.placeholder;
    if (placeholder !== undefined && placeholder !== '') {
      add(
        'placeholder',
        `getByPlaceholder(${quote(placeholder)})`,
        node,
        all.filter(other => other.props.placeholder === placeholder),
        BASE.placeholder,
        ['a placeholder disappears once the field is filled'],
      );
    }

    const text = node.text;
    if (text !== undefined && text !== '') {
      add(
        'text',
        `getByText(${quote(text)}, { exact: true })`,
        node,
        all.filter(other => sameName(other.text, text) || sameName(other.name, text)),
        BASE.text,
        text.length > LONG_TEXT ? ['long text — may be dynamic or localised'] : [],
      );
    }
  }

  // Best first, with a fixed strategy order as the tiebreak so the output is stable across runs.
  const order: CandidateStrategy[] = [
    'role',
    'roleInLandmark',
    'placeholder',
    'text',
    'roleOrdinal',
  ];
  return candidates.sort(
    (a, b) =>
      b.score - a.score ||
      order.indexOf(a.strategy) - order.indexOf(b.strategy) ||
      a.code.localeCompare(b.code),
  );
}

/** The landmark chain a candidate sits in, for the report and the equivalence check. */
export const candidateLandmarks = (candidate: HealCandidate): string[] =>
  landmarkPath(candidate.node);
