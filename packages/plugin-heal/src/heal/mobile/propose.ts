/**
 * A repair proposal for a mobile failure.
 *
 * The same pipeline as the web path, and deliberately so: class gate, candidate ranking, equivalence
 * proof, then an edit that is planned whether or not it may be applied. Only three things differ, and
 * each is a fact about mobile rather than a different policy:
 *
 * 1. **Where the screen comes from** — a `mobile-hierarchy` attachment the fixture captured on failure,
 *    where the web reads Playwright's `error-context`.
 * 2. **Where the locator comes from** — the spec's own source line. A driver error has no `Locator:`
 *    line, so there is nothing in the message to parse.
 * 3. **Two extra refusals** — never a coordinate, never through an out-of-app warning, both applied in
 *    `target.ts` where the candidate is still mobile-shaped.
 *
 * Verification is not attempted. Re-running a mobile test needs the device that produced the failure,
 * which is not a thing this process can assume, so a mobile proposal is **always advisory** — it is
 * written, and `--apply` refuses it. That is a real limit and it is stated rather than worked around.
 *
 * @example
 * const outcome = await proposeMobileRepair({ projectDir, finding, sequence: 1 });
 * outcome.proposal?.equivalence?.verdict; // 'proven' | 'likely' | 'refused'
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Finding } from '../../triage/run.js';
import type { LocatorIntent } from '../intent.js';
import { planEdit, writeProposal, type Proposal } from '../patch.js';
import { parseMobileIntent, type MobileIntent } from './intent.js';
import { analyseWithKit, loadMobileKit, proveMobile, readHierarchy } from './target.js';

export interface MobileProposeOptions {
  projectDir: string;
  finding: Finding;
  sequence?: number;
  /** The app under test, so a candidate outside it is penalised the way the recorder penalises one. */
  appId?: string;
}

export interface MobileProposeOutcome {
  proposal: Proposal | null;
  dir?: string;
  skipped?: string;
}

/**
 * Express a mobile locator in the shared `LocatorIntent` shape.
 *
 * The mapping is not a fudge. `mobile-core`'s own locator engine documents `accessibilityId` as the
 * mobile counterpart of a test id — something a developer put there for automation — and the web
 * candidate generator scores `getByTestId` highest for the same reason. Visible text is a name in both
 * worlds. So the two vocabularies really are the same three ideas, and keeping one `LocatorIntent` means
 * the proposal, the provenance and the report render identically for a mobile repair.
 */
function asLocatorIntent(intent: MobileIntent): LocatorIntent {
  const signals: LocatorIntent['signals'] = [];
  if (intent.signals.includes('accessibilityId') || intent.signals.includes('resourceId')) {
    signals.push('testId');
  }
  if (intent.signals.includes('text')) {
    signals.push('name');
  }
  return {
    code: intent.code,
    name: intent.locator.text,
    nameKind: intent.locator.text === undefined ? undefined : 'text',
    testId: intent.locator.accessibilityId ?? intent.locator.resourceId,
    signals,
    structural: false,
  };
}

/** The source line the failing frame points at, which is also the line an edit would change. */
function sourceLine(projectDir: string, file: string, line: number): string | undefined {
  try {
    return fs.readFileSync(path.join(projectDir, file), 'utf8').split('\n')[line - 1];
  } catch {
    return undefined;
  }
}

export async function proposeMobileRepair(
  options: MobileProposeOptions,
): Promise<MobileProposeOutcome> {
  const { projectDir, finding, sequence = 1 } = options;
  const { test, failure, triage } = finding;

  if (triage.class !== 'locator-drift') {
    return {
      proposal: null,
      skipped: `${triage.class}: only locator-drift is ever repaired`,
    };
  }

  const captured = readHierarchy(projectDir, finding);
  if (captured === undefined) {
    return {
      proposal: null,
      skipped:
        'no screen was captured for this failure — @pwtap/mobile-core writes a mobile-hierarchy attachment when a mobile test fails, so this run either predates it or used a driver with no hierarchy support',
    };
  }

  const file = failure?.topFrame?.file ?? test.file;
  const line = failure?.topFrame?.line ?? test.line;
  const raw = sourceLine(projectDir, file, line);
  const mobileIntent = raw === undefined ? undefined : parseMobileIntent(raw);
  if (mobileIntent === undefined) {
    return {
      proposal: null,
      skipped: `could not read a locator literal from ${file}:${line} — a locator built from a variable or a template is not one this can rewrite safely`,
    };
  }
  if (mobileIntent.coordinateOnly) {
    return {
      proposal: null,
      skipped:
        'the locator states only a coordinate, which identifies nothing — there is no element for a replacement to be equivalent to',
    };
  }

  const kit = await loadMobileKit();
  if (kit === undefined) {
    return {
      proposal: null,
      skipped:
        'install @pwtap/mobile-core to rank mobile replacements — its locator engine is where the scoring lives, and duplicating it here would be a second engine to keep in step',
    };
  }

  const intent = asLocatorIntent(mobileIntent);
  const refusals: string[] = [];
  const checked = ['class is locator-drift', 'the failing run captured the screen'];

  for (const veto of triage.vetoes) {
    if (veto !== 'not-locator-drift') {
      refusals.push(veto);
    }
  }
  if (triage.confidence < 85) {
    refusals.push(`confidence ${triage.confidence} is below the 85 needed to act`);
  } else {
    checked.push(`confidence ${triage.confidence} reaches the act band`);
  }

  const analysis = analyseWithKit(kit, captured, mobileIntent, options.appId);
  const proposal: Proposal = {
    testKey: test.testKey,
    project: test.project,
    file,
    line,
    title: test.titlePath.join(' › '),
    triage,
    target: 'mobile',
    intent,
    candidates: analysis.candidates,
    refusals,
    checked,
    applied: false,
  };

  if (analysis.problem !== undefined) {
    proposal.refusals.push(analysis.problem);
    return { proposal, dir: writeProposal(projectDir, proposal, sequence) };
  }

  const [best, second] = analysis.candidates;
  proposal.chosen = best;
  if (second !== undefined && best.score - second.score < 5 && best.node !== second.node) {
    proposal.refusals.push(
      `ambiguous: the top two candidates score ${best.score} and ${second.score} and point at different elements`,
    );
  } else {
    proposal.checked.push('one candidate leads the ranking clearly');
  }

  const equivalence = proveMobile(kit, mobileIntent, best, captured);
  proposal.equivalence = equivalence;
  if (equivalence.verdict === 'proven') {
    proposal.checked.push(`equivalence proven via ${equivalence.matched.join(' and ')}`);
  } else {
    proposal.refusals.push(`equivalence ${equivalence.verdict}: ${equivalence.reasons.join('; ')}`);
  }

  const planned = planEdit(projectDir, file, line, mobileIntent.code, best.code);
  if ('problem' in planned) {
    proposal.refusals.push(`cannot-edit: ${planned.problem}`);
  } else {
    proposal.edit = planned.edit;
  }

  // Always. Verifying a mobile repair means re-running the test on the device that produced the
  // failure, and nothing here can assume that device is still attached — so a mobile proposal is a
  // proposal, and a human runs it.
  proposal.refusals.push(
    'not verified: a mobile repair cannot be re-run from here, so it stays advisory and a human runs it on the device',
  );

  return { proposal, dir: writeProposal(projectDir, proposal, sequence) };
}
