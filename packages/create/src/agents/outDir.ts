/**
 * Where a rendered plugin directory goes, and why it goes there.
 *
 * Claude Code runs a marketplace `command` source from the user's home directory and refuses the
 * printed path when it is the session's working directory or one of its parents. So the output must
 * be nested under `$HOME` — `~/.pwtap/claude-plugin/<slug>` — never `$HOME` itself and never inside
 * the consumer's repo (which would also need a .gitignore entry, and in link mode would stop the
 * plugin loading for any session started below it).
 *
 * There is deliberately no content hash in the directory name: in `copy` mode Claude Code hashes the
 * directory's *contents* to derive the version, so a stable path rewritten in place is correct and
 * needs no garbage collection. Content-hashed names are a `link`-mode requirement.
 *
 * `PWTAP_AGENTS_OUT` overrides the root — required by the tests, which must never write into the
 * developer's home directory.
 *
 * @example
 * outDirFor('/Users/me/work/checkout-tests'); // ~/.pwtap/claude-plugin/checkout-tests-9f2a1c04
 */
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/**
 * Everything pwtap keeps outside a project. `PWTAP_HOME` exists so a test never writes into the
 * developer's real home directory.
 */
export function pwtapHome(): string {
  const override = process.env.PWTAP_HOME;
  return override !== undefined && override !== ''
    ? path.resolve(override)
    : path.join(os.homedir(), '.pwtap');
}

/** The root every rendered plugin directory lives under. */
export function agentsOutRoot(): string {
  const override = process.env.PWTAP_AGENTS_OUT;
  if (override !== undefined && override !== '') {
    return path.resolve(override);
  }
  return path.join(pwtapHome(), 'claude-plugin');
}

/**
 * The directory for one project, or the baseline directory when no project was resolved. Stable for
 * a given project: the path changes only when the *detected project* changes, which the docs allow.
 */
export function outDirFor(projectDir: string | null): string {
  if (projectDir === null) {
    return path.join(agentsOutRoot(), 'none');
  }
  const absolute = path.resolve(projectDir);
  const digest = createHash('sha256').update(absolute).digest('hex').slice(0, 8);
  // The basename is for a human reading `~/.pwtap/claude-plugin/`; the digest is what makes it
  // unique, so a basename that is empty or awkward (a drive root, a dot) degrades rather than breaks.
  const base = path.basename(absolute).replace(/[^A-Za-z0-9._-]/g, '-') || 'project';
  return path.join(agentsOutRoot(), `${base}-${digest}`);
}
