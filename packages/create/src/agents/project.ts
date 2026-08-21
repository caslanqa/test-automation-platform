/**
 * Which project the renderer is rendering for — the one genuinely hard problem in this feature.
 *
 * Claude Code runs a marketplace `command` source **from the user's home directory**, and the docs
 * enumerate the contexts that receive `CLAUDE_PROJECT_DIR` — hook, MCP and LSP subprocesses — which
 * a marketplace command is not. The command string is also frozen once a user accepts it, so the
 * project cannot be passed as an argument after publication either. Hence a chain, first hit wins:
 *
 * 1. `--project <dir>` — used by `init-agents`, the smoke script, and anyone debugging
 * 2. `PWTAP_PROJECT` — the documented deterministic escape hatch, inherited from the user's shell
 * 3. `CLAUDE_PROJECT_DIR` — read opportunistically; if it turns out to be present this becomes the
 *    primary path and the rest is dead weight, which would be a good outcome
 * 4. `~/.pwtap/projects.json` — written by `create`, `add` and `remove`. One entry is the common
 *    case (one test-automation repo per machine); several means most-recently-seen wins
 * 5. nothing — a baseline, core-only render. Never fail a session start over a missing project
 *
 * ponytail: most-recent-wins is wrong for someone alternating two pwtap projects in parallel
 * sessions; the upgrade path is PWTAP_PROJECT, or CLAUDE_PROJECT_DIR if it proves to be exported.
 *
 * @example
 * resolveProject(); // { dir: '/Users/me/suite', source: 'PWTAP_PROJECT' }
 */
import fs from 'node:fs';
import path from 'node:path';

import { pwtapHome } from './outDir.js';

/** Where a project came from, so `/pwtap:vv-status` can explain a wrong roster. */
export type ProjectSource =
  '--project' | 'PWTAP_PROJECT' | 'CLAUDE_PROJECT_DIR' | 'registry' | 'none';

export interface ResolvedProject {
  dir: string | null;
  source: ProjectSource;
}

interface RegistryEntry {
  dir: string;
  lastSeen: number;
}

interface Registry {
  projects: RegistryEntry[];
}

/** Keep the file small and readable; a machine with more than this many suites is not the case to optimise for. */
const MAX_ENTRIES = 20;

export function registryPath(): string {
  return path.join(pwtapHome(), 'projects.json');
}

function readRegistry(): Registry {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(), 'utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as Registry).projects)
    ) {
      return {
        projects: (parsed as Registry).projects.filter(
          entry =>
            typeof entry?.dir === 'string' && entry.dir !== '' && Number.isFinite(entry?.lastSeen),
        ),
      };
    }
  } catch {
    // A missing or corrupt registry is not an error — it means "resolve from somewhere else".
  }
  return { projects: [] };
}

/**
 * Remember a project so a later render can find it. Called from `create`, `add` and `remove`, which
 * are the only moments we know for certain which project the user means.
 *
 * Best-effort by design: a read-only `$HOME` must not make `create-pwtap add` fail.
 * `now` is injectable so a test does not have to depend on the clock.
 */
export function recordProject(projectDir: string, now: number = Date.now()): void {
  try {
    const absolute = path.resolve(projectDir);
    const kept = readRegistry()
      .projects.filter(entry => entry.dir !== absolute && fs.existsSync(entry.dir))
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, MAX_ENTRIES - 1);
    fs.mkdirSync(pwtapHome(), { recursive: true });
    fs.writeFileSync(
      registryPath(),
      `${JSON.stringify({ projects: [{ dir: absolute, lastSeen: now }, ...kept] }, null, 2)}\n`,
    );
  } catch {
    // Nothing to do and nothing to say: the registry is a convenience, not a contract.
  }
}

const fromEnv = (name: string): string | undefined => {
  const value = process.env[name];
  return value !== undefined && value.trim() !== '' ? value : undefined;
};

export function resolveProject(argvProject?: string): ResolvedProject {
  if (argvProject !== undefined && argvProject.trim() !== '') {
    return { dir: path.resolve(argvProject), source: '--project' };
  }
  const explicit = fromEnv('PWTAP_PROJECT');
  if (explicit !== undefined) {
    return { dir: path.resolve(explicit), source: 'PWTAP_PROJECT' };
  }
  const fromClaude = fromEnv('CLAUDE_PROJECT_DIR');
  if (fromClaude !== undefined) {
    return { dir: path.resolve(fromClaude), source: 'CLAUDE_PROJECT_DIR' };
  }
  const alive = readRegistry()
    .projects.filter(entry => fs.existsSync(entry.dir))
    .sort((a, b) => b.lastSeen - a.lastSeen);
  if (alive.length > 0) {
    return { dir: alive[0].dir, source: 'registry' };
  }
  return { dir: null, source: 'none' };
}
