/**
 * What changed in this change — the evidence that separates "someone just edited this test" from
 * "the application moved underneath it".
 *
 * Degrades to "unknown" rather than throwing: a shallow clone, a detached head, a missing `git`, or
 * a base ref that does not exist are all normal, and a triage that crashes on them is worse than one
 * that says it could not tell.
 *
 * @example
 * changedFiles('/repo', 'main'); // → { known: true, files: ['tests/checkout.spec.ts'] }
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export interface ChangedFiles {
  /** False when git could not answer — the caller must then not infer anything. */
  known: boolean;
  /** POSIX paths relative to the repository root. */
  files: string[];
  /** What the diff was taken against, for the report. */
  base?: string;
}

function git(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

/**
 * Files touched between `base` and HEAD, plus anything uncommitted — a test edited in the working
 * tree is exactly the case where rewriting it underneath the author is worst.
 */
export function changedFiles(projectDir: string, baseRef?: string): ChangedFiles {
  const candidates = [baseRef, 'HEAD~1'].filter(
    (ref): ref is string => ref !== undefined && ref !== '',
  );

  const workingTree = (): string[] | undefined => {
    const dirty = git(['status', '--porcelain'], projectDir);
    return dirty === undefined
      ? undefined
      : dirty
          .split('\n')
          .map(line => line.slice(3).trim())
          .filter(line => line !== '');
  };

  for (const ref of candidates) {
    // `...` is the merge-base form: what this branch changed, not what the base changed since.
    const out = git(['diff', '--name-only', `${ref}...HEAD`], projectDir);
    if (out !== undefined) {
      const working = workingTree() ?? [];
      const files = [
        ...new Set(
          [...out.split('\n'), ...working].map(file => file.trim()).filter(file => file !== ''),
        ),
      ];
      return { known: true, files, base: ref };
    }
  }

  // No comparable base — a repository with a single commit, or the shallow `--depth=1` clone most CI
  // checkouts produce. Git can still answer whether the working tree is dirty, and "nothing is
  // modified" is a real answer rather than an absence of one. Reporting it as unknown would silently
  // discard the diff evidence on the majority of CI runs.
  const working = workingTree();
  if (working !== undefined) {
    return { known: true, files: working, base: 'working-tree' };
  }
  return { known: false, files: [] };
}

/** Does `file` (relative to the project) appear in the change set? */
export function touched(changed: ChangedFiles, file: string | undefined): boolean {
  if (!changed.known || file === undefined) {
    return false;
  }
  const normalized = file.split(path.sep).join('/');
  return changed.files.some(
    candidate => candidate === normalized || candidate.endsWith(`/${normalized}`),
  );
}

/** The commit a heal was applied at, so the log can be tied to a point in history. */
export const headCommit = (projectDir: string): string | undefined =>
  git(['rev-parse', 'HEAD'], projectDir)?.trim() || undefined;
