/**
 * The coverage gate — the part a CI job fails on.
 *
 * Pure, and separate from rendering, because a gate that is computed while printing cannot be tested
 * and cannot be reasoned about. It takes the matrix and answers one question: **is there a requirement
 * this repository claims to hold itself to, that no test proves?**
 *
 * What counts as a failure, and the reasoning for each:
 *
 * | Finding | Why it fails |
 * |---|---|
 * | `uncovered` | a `valid`/`implemented` requirement no test names at all |
 * | `failing` | a requirement whose test ran and went red — covered, but not verified |
 * | `not-run` | a results report WAS read and the requirement's tests are not in it. A green job whose relevant test never executed is not evidence — the same rule `vv-lead` applies to a suite |
 * | `dangling` | a test names a requirement no file defines: the link is broken in the direction nobody notices |
 * | `problem` | a requirement file that could not be read. Silently skipping it would shrink the denominator and make coverage look better |
 *
 * `draft`, `review` and `obsolete` requirements are **excluded** — see {@link GATED_STATUSES}. A gate
 * that fails on work not started yet gets switched off, and a switched-off gate protects nothing.
 *
 * With no results report the gate checks coverage only, and says so, rather than failing every
 * requirement as unverified.
 *
 * @example
 * const verdict = gateMatrix(matrix, { resultsRead: true, problems: [] });
 * process.exit(verdict.ok ? 0 : 1);
 */
import type { RequirementProblem } from './load.js';
import { GATED_STATUSES, type Matrix } from './rtm.js';

export type FindingKind = 'uncovered' | 'failing' | 'not-run' | 'dangling' | 'problem';

export interface GateFinding {
  kind: FindingKind;
  /** The requirement id, the reference, or the file — whatever names the thing that failed. */
  subject: string;
  detail: string;
}

export interface GateOptions {
  /** True when a results report was actually read; drives whether `not-run` is a failure. */
  resultsRead: boolean;
  /** Loader problems, so a malformed requirement file fails the gate rather than vanishing. */
  problems?: readonly RequirementProblem[];
  /** Also require every declared acceptance criterion to be covered. Off by default. */
  strict?: boolean;
}

export interface GateVerdict {
  ok: boolean;
  findings: GateFinding[];
  /** One line, already written for a human. */
  summary: string;
}

export function gateMatrix(matrix: Matrix, options: GateOptions): GateVerdict {
  const findings: GateFinding[] = [];

  for (const problem of options.problems ?? []) {
    findings.push({
      kind: 'problem',
      subject: problem.file,
      detail: problem.reason,
    });
  }

  for (const row of matrix.rows) {
    if (row.verdict === 'excluded') {
      continue;
    }
    if (row.verdict === 'uncovered') {
      findings.push({
        kind: 'uncovered',
        subject: row.requirement.id,
        detail: `${row.requirement.title} — no test carries a Requirement annotation naming it`,
      });
      continue;
    }
    if (row.verdict === 'failing') {
      const red = row.tests.filter(
        test => test.outcome === 'failed' || test.outcome === 'timedOut',
      );
      findings.push({
        kind: 'failing',
        subject: row.requirement.id,
        detail: `${row.requirement.title} — ${red.length > 0 ? red.map(test => test.name).join('; ') : 'a linked test did not pass'}`,
      });
      continue;
    }
    if (row.verdict === 'not-run' && options.resultsRead) {
      findings.push({
        kind: 'not-run',
        subject: row.requirement.id,
        detail: `${row.requirement.title} — covered by ${row.tests.length} test(s), none of which ran`,
      });
      continue;
    }

    if (options.strict) {
      for (const criterion of row.criteria) {
        if (criterion.verdict === 'uncovered') {
          findings.push({
            kind: 'uncovered',
            subject: `${row.requirement.id}#${criterion.criterion.id}`,
            detail: `${criterion.criterion.text} — no test names this criterion`,
          });
        }
      }
    }
  }

  for (const entry of matrix.dangling) {
    findings.push({
      kind: 'dangling',
      subject: entry.reference,
      detail: `${entry.test.name} (${entry.test.file}:${entry.test.line}) names a requirement no file defines`,
    });
  }

  const gated = matrix.rows.filter(row => GATED_STATUSES.includes(row.requirement.status)).length;
  const summary =
    findings.length === 0
      ? `${gated} requirement(s) held to account, all covered${options.resultsRead ? ' and verified' : ' (coverage only — no run results were read)'}`
      : `${findings.length} finding(s) across ${gated} requirement(s) held to account`;

  return { ok: findings.length === 0, findings, summary };
}
