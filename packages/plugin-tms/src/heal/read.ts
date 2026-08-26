/**
 * Reading `@pwtap/plugin-heal`'s output — **by file, never by import**.
 *
 * The obvious design was an optional peer dependency and a guarded `await import()`. This is better,
 * and the reason is written down because it is easy to talk yourself back into the other one:
 *
 * - **No build coupling.** `@pwtap/plugin-heal`'s own `test/optionalPeers.test.ts` exists because a
 *   literal dynamic specifier made a peer's declarations a compile-time requirement and broke a
 *   release. Naming no package at all cannot regress that way.
 * - **No version skew.** Both files below are stable, documented artifacts a human already runs a
 *   command to produce. A shape change shows up here as a readable "this is not a heal triage report",
 *   not as a type error in someone's install.
 * - **heal stays optional in the honest sense.** A project without it simply has no such file, and the
 *   command says so.
 *
 * Two file paths, two contracts:
 *
 * | File | Produced by | Committed? |
 * |---|---|---|
 * | `.heal/triage.json` | `heal triage --json .heal/triage.json` | no — it describes one run |
 * | `heal/quarantine.json` | `heal quarantine`, edited by hand | yes — it is policy |
 *
 * @example
 * const triage = readTriage('/repo/.heal/triage.json');
 * triage?.findings.filter(finding => finding.class === 'true-fail');
 */
import fs from 'node:fs';

export const DEFAULT_TRIAGE_FILE = '.heal/triage.json';
export const DEFAULT_QUARANTINE_FILE = 'heal/quarantine.json';

/** heal's classification. Only `true-fail` may ever become a defect. */
export type TriageClass = 'flaky' | 'locator-drift' | 'true-fail' | 'env-infra' | 'unknown';

export interface TriageFinding {
  testKey: string;
  project: string;
  /** Relative to the PROJECT root — not to Playwright's `rootDir`, which is the tests directory. */
  file: string;
  line?: number;
  /** Describes and the test title, joined by ` › `. No file path in it. */
  title: string;
  outcome: string;
  class: TriageClass;
  confidence: number;
  band: 'act' | 'advise' | 'ask';
  reasons?: string[];
}

export interface TriageReport {
  runId: string;
  startedAt?: string;
  commit?: string;
  findings: TriageFinding[];
}

/** `undefined` when the file is absent — a project without heal is not an error. */
export function readTriage(file: string): TriageReport | undefined {
  if (!fs.existsSync(file)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not valid JSON — regenerate it with "heal triage --json ${file}"`);
  }

  const report = parsed as Partial<TriageReport>;
  if (!Array.isArray(report.findings)) {
    throw new Error(
      `${file} has no "findings" array — it does not look like a heal triage report. ` +
        `Produce one with "heal triage --json ${file}".`,
    );
  }

  return {
    runId: typeof report.runId === 'string' ? report.runId : 'unknown',
    ...(typeof report.startedAt === 'string' ? { startedAt: report.startedAt } : {}),
    ...(typeof report.commit === 'string' ? { commit: report.commit } : {}),
    findings: report.findings.filter(
      (finding): finding is TriageFinding =>
        typeof finding?.testKey === 'string' &&
        typeof finding.title === 'string' &&
        typeof finding.class === 'string',
    ),
  };
}

export interface QuarantineEntry {
  testKey: string;
  project: string;
  file: string;
  title: string;
  class: 'flaky' | 'env-infra';
  reason: string;
  expiresAt?: string;
}

/** The committed quarantine list, or `[]` when there is none. */
export function readQuarantine(file: string): QuarantineEntry[] {
  if (!fs.existsSync(file)) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }

  const entries = (parsed as { entries?: unknown }).entries;
  return Array.isArray(entries)
    ? entries.filter(
        (entry): entry is QuarantineEntry =>
          typeof entry?.testKey === 'string' && typeof entry.title === 'string',
      )
    : [];
}
