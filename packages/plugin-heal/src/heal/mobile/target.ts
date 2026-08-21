/**
 * The mobile healing target.
 *
 * **The discovery that makes this possible without a device.** The web path reads an ARIA snapshot
 * Playwright already wrote at the moment of failure. Mobile had no equivalent — the driver session is
 * closed in the fixture's teardown and the tree goes with it — so `@pwtap/mobile-core` now captures one
 * into a `mobile-hierarchy` attachment when, and only when, a test fails. That turns mobile repair into
 * the same shape as web repair: read a file the run left behind, rank replacements, prove one.
 *
 * Without it the plan's alternative was a post-run probe against a booted device, which cannot run in CI
 * and therefore could not be tested at all.
 *
 * **Mobile is the easier half, and the reason is worth stating.** The ranking already exists and is
 * already unit-tested (`mobile-core/src/locator.ts`), uniqueness is already computed against the live
 * tree, and identity is *stronger* than on the web: an `accessibilityId` is a hook someone put there
 * deliberately, where an accessible name is a by-product of the markup. So this file is glue and
 * refusals, not a second engine.
 *
 * `@pwtap/mobile-core` is an **optional** peer, reached through a guarded import: a web-only project
 * must not install a mobile package to use the healer.
 *
 * @example
 * const analysis = await analyseMobile(projectDir, finding);
 * analysis?.candidates[0].code; // "{ accessibilityId: 'loginButton' }"
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Finding } from '../../triage/run.js';
import type { HealCandidate } from '../candidates.js';
import type { Equivalence } from '../equivalence.js';
import type { MobileIntent } from './intent.js';
import type { MobileCandidateLike, MobileKit, MobileLocatorLike, MobileNodeLike } from './types.js';

/** The attachment `@pwtap/mobile-core` writes on a failing mobile test. */
export const HIERARCHY_ATTACHMENT = 'mobile-hierarchy';

/** The minimum score a mobile candidate must reach, matching the web target's bar. */
export const MIN_MOBILE_SCORE = 60;

let kitPromise: Promise<MobileKit | undefined> | undefined;

/**
 * Held in a variable rather than written inline, so TypeScript does not resolve it — see the same note in
 * `escalate/client.ts`. `MobileKit` in `./types.ts` is a structural copy so this package does not depend
 * on `@pwtap/mobile-core` at build time; a literal specifier here quietly reintroduced that dependency
 * and broke a release when `changeset publish` cleaned the two packages' `dist` directories in parallel.
 */
const MOBILE_CORE_PACKAGE = '@pwtap/mobile-core';

/** Load `@pwtap/mobile-core`, once per process. Absent is a normal state, not an error. */
export async function loadMobileKit(): Promise<MobileKit | undefined> {
  kitPromise ??= (async () => {
    try {
      const core = (await import(MOBILE_CORE_PACKAGE)) as Partial<MobileKit>;
      return typeof core.locatorCandidates === 'function' && typeof core.countMatches === 'function'
        ? (core as MobileKit)
        : undefined;
    } catch {
      return undefined;
    }
  })();
  return kitPromise;
}

export interface CapturedHierarchy {
  driver?: string;
  nodes: MobileNodeLike[];
}

/** Read the tree the failing run recorded. Undefined when it recorded none. */
export function readHierarchy(projectDir: string, finding: Finding): CapturedHierarchy | undefined {
  const attachment = finding.failure?.attachments.find(item => item.name === HIERARCHY_ATTACHMENT);
  if (attachment === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(projectDir, attachment.path), 'utf8')) as {
      driver?: string;
      nodes?: MobileNodeLike[];
    };
    return Array.isArray(parsed.nodes) ? { driver: parsed.driver, nodes: parsed.nodes } : undefined;
  } catch {
    return undefined;
  }
}

/** Every node, depth-first. */
export function flattenNodes(nodes: readonly MobileNodeLike[]): MobileNodeLike[] {
  const out: MobileNodeLike[] = [];
  const walk = (list: readonly MobileNodeLike[]): void => {
    for (const node of list) {
      out.push(node);
      walk(node.children ?? []);
    }
  };
  walk(nodes);
  return out;
}

const normalise = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Elements that still match something the old locator stated.
 *
 * The old locator resolves to nothing — that is why the test failed — so a target is a node agreeing on
 * at least one of its signals. A locator with no signals at all (a bare coordinate) has no target by
 * construction, which is the refusal, not a bug.
 */
export function mobileTargets(
  nodes: readonly MobileNodeLike[],
  intent: MobileIntent,
): MobileNodeLike[] {
  const wanted = intent.locator;
  return flattenNodes(nodes).filter(node => {
    if (wanted.accessibilityId !== undefined && node.accessibilityId === wanted.accessibilityId) {
      return true;
    }
    if (wanted.resourceId !== undefined && node.resourceId === wanted.resourceId) {
      return true;
    }
    return (
      wanted.text !== undefined &&
      typeof node.text === 'string' &&
      normalise(node.text) === normalise(wanted.text)
    );
  });
}

/** Render a locator the way `mobile-core`'s own codegen does, so a healed line reads like a written one. */
export function renderLocator(locator: MobileLocatorLike): string {
  const parts: string[] = [];
  for (const key of ['accessibilityId', 'resourceId', 'text'] as const) {
    const value = locator[key];
    if (typeof value === 'string') {
      parts.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  if (typeof locator.index === 'number') {
    parts.push(`index: ${locator.index}`);
  }
  return `{ ${parts.join(', ')} }`;
}

/** Turn mobile-core's ranking into the shape the rest of the engine already understands. */
function toHealCandidate(
  candidate: MobileCandidateLike,
  node: MobileNodeLike,
): HealCandidate<MobileNodeLike> {
  return {
    strategy: candidate.strategy === 'point' ? 'point' : candidate.strategy,
    code: candidate.code ?? renderLocator(candidate.locator),
    score: candidate.score,
    confidence: candidate.confidence,
    unique: candidate.unique,
    warnings: candidate.warnings,
    node,
  };
}

export interface MobileAnalysis {
  nodes: MobileNodeLike[];
  targets: MobileNodeLike[];
  candidates: Array<HealCandidate<MobileNodeLike>>;
  /** Why nothing usable came out, when nothing did. */
  problem?: string;
}

/**
 * Rank replacements for a mobile locator.
 *
 * Two refusals are applied here rather than downstream, because both are facts about the candidate
 * itself and neither is recoverable once it has been turned into a generic one:
 *
 * - **never a coordinate.** `strategy: 'point'` is mobile-core's last-resort fallback and it encodes a
 *   pixel position; healing to one produces a test that passes today and taps empty space after any
 *   layout change.
 * - **never through an out-of-app warning.** A node belonging to the status bar or another app cannot be
 *   acted on by a driver scoped to the app under test, so that locator would not resolve on replay at
 *   all. `mobile-core` already flags both, so this reads its warnings rather than recomputing them.
 */
export function analyseWithKit(
  kit: MobileKit,
  captured: CapturedHierarchy,
  intent: MobileIntent,
  appId?: string,
): MobileAnalysis {
  const targets = mobileTargets(captured.nodes, intent);
  if (targets.length === 0) {
    return {
      nodes: captured.nodes,
      targets,
      candidates: [],
      problem:
        'no-target: nothing on the captured screen matches anything this locator stated, so there is no element to point at',
    };
  }

  const ranked: Array<HealCandidate<MobileNodeLike>> = [];
  for (const target of targets) {
    for (const candidate of kit.locatorCandidates(target, captured.nodes, { appId })) {
      if (candidate.strategy === 'point') {
        continue;
      }
      if (
        candidate.warnings.some(warning => /outside the app under test|out-of-app/i.test(warning))
      ) {
        continue;
      }
      ranked.push(toHealCandidate(candidate, target));
    }
  }

  // Score first, then strategy order, so the output is stable across runs.
  const ORDER = ['accessibilityId', 'resourceId', 'text'];
  ranked.sort((a, b) => b.score - a.score || ORDER.indexOf(a.strategy) - ORDER.indexOf(b.strategy));

  return {
    nodes: captured.nodes,
    targets,
    candidates: ranked,
    problem:
      ranked.length === 0
        ? 'no-candidate: every replacement for this element was a coordinate or pointed outside the app under test'
        : undefined,
  };
}

/**
 * Is the candidate the same element?
 *
 * The bar is the web's, deliberately: **two independent signals**, uniqueness, and a neighbourhood that
 * has not changed. Mobile can be stricter about the last one than the web can — `assignNodeIdentity`
 * writes a `key` combining the position chain with the identifiers, so "the same element" is a question
 * with a real answer rather than an approximation.
 */
export function proveMobile(
  kit: MobileKit,
  intent: MobileIntent,
  candidate: HealCandidate<MobileNodeLike>,
  captured: CapturedHierarchy,
): Equivalence {
  const matched: Equivalence['matched'] = [];
  const reasons: string[] = [];
  const node = candidate.node;
  const stated = intent.locator;

  if (stated.accessibilityId !== undefined && node.accessibilityId === stated.accessibilityId) {
    matched.push('accessibilityId');
  }
  if (stated.resourceId !== undefined && node.resourceId === stated.resourceId) {
    matched.push('resourceId');
  }
  if (
    stated.text !== undefined &&
    typeof node.text === 'string' &&
    normalise(node.text) === normalise(stated.text)
  ) {
    matched.push('text');
  }

  const uniqueMatches = kit.countMatches(captured.nodes, parseCandidateLocator(candidate));

  if (matched.length < 2) {
    reasons.push(
      matched.length === 0
        ? 'no-shared-signal: nothing the locator stated is still on this screen, so no replacement can be shown to be the same element'
        : `insufficient-signals: the locator stated only ${matched[0]}, and one identifier cannot distinguish this element from another carrying it`,
    );
  }
  if (uniqueMatches !== 1) {
    reasons.push(
      uniqueMatches === 0
        ? 'the replacement matches nothing on the captured screen'
        : `the replacement matches ${uniqueMatches} elements`,
    );
  }
  if (candidate.score < MIN_MOBILE_SCORE) {
    reasons.push(
      `the best replacement scores ${candidate.score}, below the ${MIN_MOBILE_SCORE} bar`,
    );
  }

  if (matched.length >= 2 && uniqueMatches === 1 && candidate.score >= MIN_MOBILE_SCORE) {
    return { verdict: 'proven', matched, uniqueMatches, landmarkPath: [], reasons: [] };
  }
  return {
    verdict: matched.length >= 1 && uniqueMatches === 1 ? 'likely' : 'refused',
    matched,
    uniqueMatches,
    landmarkPath: [],
    reasons,
  };
}

/** The locator a candidate would write, read back from its rendered code. */
function parseCandidateLocator(candidate: HealCandidate<MobileNodeLike>): MobileLocatorLike {
  const node = candidate.node;
  switch (candidate.strategy) {
    case 'accessibilityId':
      return { accessibilityId: node.accessibilityId };
    case 'resourceId':
      return { resourceId: node.resourceId };
    default:
      return { text: node.text };
  }
}
