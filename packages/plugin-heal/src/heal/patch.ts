/**
 * What a proposal is made of: the edit, a unified diff, and a provenance record.
 *
 * Nothing is written to a spec unless `heal propose --apply` is given AND the equivalence was
 * `proven`. The default output is a directory a human reads.
 *
 * The diff is produced by `git diff --no-index` rather than a hand-rolled differ: git is already
 * required for the classifier's diff correlation, so this adds no dependency and no bug surface.
 *
 * `refusals` is recorded **even on success** — a reviewer's first question is what was checked, and a
 * list of passed checks answers it faster than prose.
 *
 * @example
 * writeProposal(dir, proposal); // → .heal/proposals/<testKey>-<n>/{patch.diff,provenance.json,report.md}
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Triage } from '../triage/classify.js';
import type { HealCandidate } from './candidates.js';
import type { Equivalence } from './equivalence.js';
import type { LocatorIntent } from './intent.js';
import type { RerunResult } from './rerun.js';

export const PROPOSALS_DIR = path.join('.heal', 'proposals');

export interface CodeEdit {
  /** Spec path relative to the project. */
  file: string;
  line: number;
  before: string;
  after: string;
}

export interface Proposal {
  testKey: string;
  project: string;
  file: string;
  line: number;
  title: string;
  triage: Triage;
  intent: LocatorIntent;
  /**
   * The full ranked list, so a reviewer can see what else was on the table. Loosely typed on the node
   * because a mobile proposal carries a `MobileNode` there and every other field is identical.
   */
  candidates: Array<HealCandidate<unknown>>;
  chosen?: HealCandidate<unknown>;
  /** Which engine produced this. `mobile` reads a captured hierarchy where `web` reads an ARIA snapshot. */
  target?: 'web' | 'mobile';
  equivalence?: Equivalence;
  verification?: RerunResult;
  edit?: CodeEdit;
  /** Everything that blocked an automatic application; empty means it is eligible. */
  refusals: string[];
  /** Checks that passed, so a reviewer sees what was verified rather than inferring it. */
  checked: string[];
  applied: boolean;
}

/**
 * Replace the locator expression on one line.
 *
 * Deliberately a single-line, single-occurrence replacement: a locator that appears twice on one line
 * is ambiguous, and a multi-line edit is a refactor rather than a repair.
 */
export function planEdit(
  projectDir: string,
  file: string,
  line: number,
  from: string,
  to: string,
): { edit: CodeEdit } | { problem: string } {
  const absolute = path.join(projectDir, file);
  let source: string;
  try {
    source = fs.readFileSync(absolute, 'utf8');
  } catch {
    return { problem: `cannot read ${file}` };
  }
  const lines = source.split('\n');
  const index = line - 1;
  const current = lines[index];
  if (current === undefined) {
    return { problem: `${file} has no line ${line}` };
  }
  const occurrences = current.split(from).length - 1;
  if (occurrences === 0) {
    // The message named a locator the source line does not contain — usually because the locator is
    // built in a page object and the failing frame is elsewhere.
    return { problem: `${file}:${line} does not contain ${from}` };
  }
  if (occurrences > 1) {
    return { problem: `${file}:${line} contains ${from} ${occurrences} times — ambiguous` };
  }
  return { edit: { file, line, before: current, after: current.replace(from, to) } };
}

/** A unified diff of the one-line change, via git so there is no differ of ours to be wrong. */
export function unifiedDiff(projectDir: string, edit: CodeEdit): string {
  const absolute = path.join(projectDir, edit.file);
  const original = fs.readFileSync(absolute, 'utf8');
  const lines = original.split('\n');
  lines[edit.line - 1] = edit.after;
  const patched = lines.join('\n');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-heal-diff-'));
  const before = path.join(temp, 'before');
  const after = path.join(temp, 'after');
  try {
    fs.writeFileSync(before, original);
    fs.writeFileSync(after, patched);
    try {
      execFileSync('git', ['diff', '--no-index', '--unified=3', '--', before, after], {
        cwd: projectDir,
        encoding: 'utf8',
      });
      // Exit 0 from `--no-index` means the files are identical, so there is nothing to apply.
      return '';
    } catch (error) {
      // git exits 1 when they differ, and the diff is on stdout — the expected path.
      const stdout = (error as { stdout?: string }).stdout ?? '';
      return stdout
        .replace(new RegExp(before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), `a/${edit.file}`)
        .replace(new RegExp(after.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), `b/${edit.file}`);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/** Apply the edit in place. Only ever called for a proven equivalence with `--apply`. */
export function applyEdit(projectDir: string, edit: CodeEdit): void {
  const absolute = path.join(projectDir, edit.file);
  const lines = fs.readFileSync(absolute, 'utf8').split('\n');
  lines[edit.line - 1] = edit.after;
  fs.writeFileSync(absolute, lines.join('\n'));
}

function report(proposal: Proposal, diff: string): string {
  const { triage, intent, chosen, equivalence, verification } = proposal;
  const lines: string[] = [
    `# Heal proposal — ${proposal.title}`,
    '',
    `- **File**: \`${proposal.file}:${proposal.line}\``,
    `- **Project**: \`${proposal.project === '' ? '(default)' : proposal.project}\``,
    `- **Triage**: ${triage.class} (${triage.confidence})`,
    `- **Applied**: ${proposal.applied ? 'yes' : 'no'}`,
    '',
    '## The assertion is unchanged',
    '',
    'This proposal only ever replaces a locator expression. No expected value, no matcher and no',
    'assertion is touched — if the failure had been a value mismatch it would have been refused',
    'outright, because that is the test doing its job.',
    '',
    '## Locator',
    '',
    `- from: \`${intent.code}\``,
    `- to:   ${chosen === undefined ? '_no candidate chosen_' : `\`${chosen.code}\``}`,
  ];

  if (chosen !== undefined) {
    lines.push(
      `- score: ${chosen.score} (${chosen.confidence}), strategy \`${chosen.strategy}\`, unique: ${chosen.unique}`,
    );
    if (chosen.warnings.length > 0) {
      lines.push('', ...chosen.warnings.map(warning => `  - ⚠ ${warning}`));
    }
  }

  if (equivalence !== undefined) {
    lines.push(
      '',
      '## Is it the same element?',
      '',
      `- verdict: **${equivalence.verdict}**`,
      `- signals matched: ${equivalence.matched.length === 0 ? 'none' : equivalence.matched.join(', ')}`,
      `- landmark path: ${equivalence.landmarkPath.length === 0 ? '(top level)' : equivalence.landmarkPath.join(' › ')}`,
      ...equivalence.reasons.map(reason => `- ${reason}`),
    );
  }

  if (verification !== undefined) {
    lines.push(
      '',
      '## Verification',
      '',
      `- consecutive greens: ${verification.greens}`,
      `- the original assertion still ran: ${verification.assertionRan ? 'yes' : 'no'}`,
      // Not "was the whole file green" — a sibling that was already red is not this candidate's
      // fault, and blaming it would refuse every repair made during a real repair session.
      `- tests it broke that were passing before: ${
        verification.newlyBroken.length === 0 ? 'none' : verification.newlyBroken.join(', ')
      }`,
      ...verification.reasons.map(reason => `- ⚠ ${reason}`),
    );
  }

  lines.push(
    '',
    '## Checks',
    '',
    ...(proposal.checked.length === 0
      ? ['- (none passed)']
      : proposal.checked.map(item => `- ✓ ${item}`)),
    ...proposal.refusals.map(item => `- ✗ ${item}`),
    '',
    '## Candidates considered',
    '',
    '| score | strategy | unique | locator |',
    '| ----- | -------- | ------ | ------- |',
    ...proposal.candidates
      .slice(0, 10)
      .map(
        candidate =>
          `| ${candidate.score} | ${candidate.strategy} | ${candidate.unique ? 'yes' : 'no'} | \`${candidate.code}\` |`,
      ),
  );

  if (diff !== '') {
    lines.push('', '## Patch', '', '```diff', diff.trimEnd(), '```');
  }
  return `${lines.join('\n')}\n`;
}

/** Write the proposal directory and return its path. */
export function writeProposal(projectDir: string, proposal: Proposal, sequence: number): string {
  const dir = path.join(projectDir, PROPOSALS_DIR, `${proposal.testKey}-${sequence}`);
  fs.mkdirSync(dir, { recursive: true });

  const diff = proposal.edit === undefined ? '' : unifiedDiff(projectDir, proposal.edit);
  if (diff !== '') {
    fs.writeFileSync(path.join(dir, 'patch.diff'), diff);
  }
  fs.writeFileSync(
    path.join(dir, 'provenance.json'),
    `${JSON.stringify(
      {
        testKey: proposal.testKey,
        project: proposal.project,
        file: proposal.file,
        line: proposal.line,
        title: proposal.title,
        triage: {
          class: proposal.triage.class,
          confidence: proposal.triage.confidence,
          reasons: proposal.triage.reasons,
        },
        from: {
          code: proposal.intent.code,
          role: proposal.intent.role,
          name: proposal.intent.name,
        },
        to:
          proposal.chosen === undefined
            ? undefined
            : {
                code: proposal.chosen.code,
                strategy: proposal.chosen.strategy,
                score: proposal.chosen.score,
                warnings: proposal.chosen.warnings,
              },
        proof: proposal.equivalence,
        verification:
          proposal.verification === undefined
            ? undefined
            : {
                ok: proposal.verification.ok,
                greens: proposal.verification.greens,
                assertionRan: proposal.verification.assertionRan,
                reasons: proposal.verification.reasons,
              },
        candidatesConsidered: proposal.candidates.map(candidate => ({
          code: candidate.code,
          strategy: candidate.strategy,
          score: candidate.score,
          unique: candidate.unique,
          warnings: candidate.warnings,
        })),
        checked: proposal.checked,
        refusals: proposal.refusals,
        applied: proposal.applied,
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(dir, 'report.md'), report(proposal, diff));
  return dir;
}
