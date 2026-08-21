/**
 * The quarantine list: committed, human-editable, and deliberately small.
 *
 * `class` is restricted to `flaky` and `env-infra`. Quarantining a `true-fail` is hiding a bug, and
 * quarantining a `locator-drift` is hiding a fix you could have made — so the CLI refuses both and
 * says which.
 *
 * It lives in `heal/` (committed), not `.heal/` (ignored), because it is **policy**: it belongs in
 * review, in `git blame`, and in the diff of the PR that added it. That is also what makes the
 * "quarantine did not grow" gate free — `git show HEAD~1:heal/quarantine.json` needs no store.
 *
 * @example
 * const list = loadQuarantine('/repo');
 * list.entries.filter(e => isExpired(e, Date.now()));
 */
import fs from 'node:fs';
import path from 'node:path';

/** Only these two classes may ever be quarantined. */
export type QuarantineClass = 'flaky' | 'env-infra';

export interface QuarantineEntry {
  testKey: string;
  project: string;
  file: string;
  title: string;
  class: QuarantineClass;
  /** Required: a quarantine with no stated reason is unreviewable. */
  reason: string;
  addedAt: string;
  expiresAt: string;
  addedBy: string;
  /** Required once the entry is older than the grace period — the gate enforces it. */
  issue?: string;
  evidence?: {
    flakeRate: number;
    runs: number;
    siteFingerprint?: string;
  };
}

export interface QuarantineFile {
  version: 1;
  entries: QuarantineEntry[];
}

export const QUARANTINE_PATH = path.join('heal', 'quarantine.json');

export const EMPTY_QUARANTINE: QuarantineFile = { version: 1, entries: [] };

const isEntry = (value: unknown): value is QuarantineEntry => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Partial<QuarantineEntry>;
  return (
    typeof entry.testKey === 'string' &&
    entry.testKey !== '' &&
    typeof entry.expiresAt === 'string' &&
    !Number.isNaN(Date.parse(entry.expiresAt)) &&
    (entry.class === 'flaky' || entry.class === 'env-infra')
  );
};

export interface LoadResult {
  file: QuarantineFile;
  /** Why the list is empty, when it is empty for a reason worth telling the user about. */
  problem?: string;
}

/**
 * Read the list. **Fails open**: a malformed or unreadable file yields an empty list and a stated
 * problem, never a throw. Shielding then simply does not happen — a parse error must never turn a
 * failing run green, and must never turn a passing one red either.
 */
export function loadQuarantine(projectDir: string): LoadResult {
  const target = path.join(projectDir, QUARANTINE_PATH);
  let raw: string;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch {
    // Absent is the normal case for a project that has never quarantined anything.
    return { file: EMPTY_QUARANTINE };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<QuarantineFile>;
    if (!Array.isArray(parsed.entries)) {
      return { file: EMPTY_QUARANTINE, problem: `${QUARANTINE_PATH}: no 'entries' array` };
    }
    const entries = parsed.entries.filter(isEntry);
    const dropped = parsed.entries.length - entries.length;
    return {
      file: { version: 1, entries },
      problem:
        dropped === 0
          ? undefined
          : `${QUARANTINE_PATH}: ignored ${dropped} malformed entr${dropped === 1 ? 'y' : 'ies'}`,
    };
  } catch (error) {
    return {
      file: EMPTY_QUARANTINE,
      problem: `${QUARANTINE_PATH} is not valid JSON (${
        error instanceof Error ? error.message : String(error)
      }) — shielding is off`,
    };
  }
}

export function saveQuarantine(projectDir: string, file: QuarantineFile): void {
  const target = path.join(projectDir, QUARANTINE_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const entries = [...file.entries].sort(
    (a, b) => a.project.localeCompare(b.project) || a.testKey.localeCompare(b.testKey),
  );
  fs.writeFileSync(target, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
}
