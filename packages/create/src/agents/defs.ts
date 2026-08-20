/**
 * Loading and validating the neutral definition source in `packages/create/agents/`.
 *
 * One definition is one markdown file. `kind` comes from the directory it sits in — `agents/`,
 * `skills/`, `commands/` — so there is one fewer field to keep in sync with reality. Everything is
 * validated at load: an unknown frontmatter key or an unknown tool name is a typo in a file we
 * ship, and it must fail our own tests rather than render a plugin that quietly lost a capability.
 *
 * @example
 * const defs = loadDefs(path.join(pkgRoot, 'agents'));
 * defs.filter(d => d.kind === 'agent').map(d => d.name);
 */
import fs from 'node:fs';
import path from 'node:path';

import { parseFrontmatter, type Frontmatter } from './frontmatter.js';
import { parseRequires, type RequiresTerms } from './requires.js';

export type DefKind = 'agent' | 'skill' | 'command';
export type LoopTarget = 'claude' | 'agents-md' | 'copilot';
export type NeutralTool = 'read' | 'search' | 'write' | 'shell' | 'web' | 'task';

/** The neutral tool vocabulary, and what each term becomes per loop. */
export const TOOL_MAP: Record<NeutralTool, { claude: string[]; copilot: string[] }> = {
  read: { claude: ['Read'], copilot: ['codebase'] },
  search: { claude: ['Grep', 'Glob'], copilot: ['search'] },
  write: { claude: ['Write', 'Edit'], copilot: ['editFiles'] },
  shell: { claude: ['Bash'], copilot: ['runCommands'] },
  web: { claude: ['WebFetch', 'WebSearch'], copilot: ['fetch'] },
  task: { claude: ['Task'], copilot: [] },
};

const ALL_TARGETS: LoopTarget[] = ['claude', 'agents-md', 'copilot'];
const KIND_DIRS: Record<DefKind, string> = {
  agent: 'agents',
  skill: 'skills',
  command: 'commands',
};

/** Keys any definition may carry. Anything else is a typo. */
const COMMON_KEYS = new Set(['name', 'description', 'requires', 'targets', 'tools']);
/** Keys only an agent may carry — a skill with `owns:` is a mistake worth surfacing. */
const AGENT_ONLY_KEYS = new Set(['model', 'effort', 'owns', 'subagentOf']);

export interface AgentDef {
  kind: DefKind;
  name: string;
  description: string;
  requires: RequiresTerms;
  /** Kept as authored too, so `/pwtap:vv-status` can explain a roster in the user's own words. */
  requiresSource: string;
  targets: LoopTarget[];
  tools: NeutralTool[];
  model?: string;
  effort?: string;
  /** Skills and commands this agent owns. Pruned against the capability set at render time. */
  owns: string[];
  subagentOf?: string;
  body: string;
  /** Source path relative to the definitions root, for error messages. */
  file: string;
}

export class DefError extends Error {
  constructor(file: string, problem: string) {
    super(`[pwtap] ${file}: ${problem}`);
    this.name = 'DefError';
  }
}

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function scalar(data: Frontmatter, key: string, file: string): string | undefined {
  const value = data[key];
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    throw new DefError(file, `'${key}' must be a single value, not a list`);
  }
  return value;
}

function list(data: Frontmatter, key: string): string[] {
  const value = data[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    // A one-item list authored without brackets is a common slip and harmless to accept.
    return value === '' ? [] : [value];
  }
  return value;
}

function parseDef(kind: DefKind, file: string, source: string): AgentDef {
  const { data, body } = parseFrontmatter(source, file);

  for (const key of Object.keys(data)) {
    if (!COMMON_KEYS.has(key) && !AGENT_ONLY_KEYS.has(key)) {
      throw new DefError(file, `unknown frontmatter key '${key}'`);
    }
    if (kind !== 'agent' && AGENT_ONLY_KEYS.has(key)) {
      throw new DefError(file, `'${key}' is only valid on an agent, and this is a ${kind}`);
    }
  }

  const name = scalar(data, 'name', file);
  if (name === undefined || name === '') {
    throw new DefError(file, "'name' is required");
  }
  if (!KEBAB.test(name)) {
    throw new DefError(file, `'name' must be kebab-case, got '${name}'`);
  }
  const basename = path.basename(file, '.md');
  if (name !== basename) {
    throw new DefError(
      file,
      `'name' is '${name}' but the file is '${basename}.md' — they must match`,
    );
  }

  const description = scalar(data, 'description', file);
  if (description === undefined || description.trim() === '') {
    throw new DefError(
      file,
      "'description' is required — it is what makes the model reach for this",
    );
  }

  const targets = list(data, 'targets');
  for (const target of targets) {
    if (!ALL_TARGETS.includes(target as LoopTarget)) {
      throw new DefError(file, `unknown target '${target}' (expected ${ALL_TARGETS.join(', ')})`);
    }
  }

  const tools = list(data, 'tools');
  for (const tool of tools) {
    if (!(tool in TOOL_MAP)) {
      throw new DefError(
        file,
        `unknown tool '${tool}' — the neutral vocabulary is ${Object.keys(TOOL_MAP).join(', ')}`,
      );
    }
  }

  const requiresSource = Array.isArray(data.requires)
    ? data.requires.join(', ')
    : (data.requires ?? 'core');

  return {
    kind,
    name,
    description: description.trim(),
    requires: parseRequires(data.requires),
    requiresSource: requiresSource === '' ? 'core' : requiresSource,
    targets: targets.length > 0 ? (targets as LoopTarget[]) : [...ALL_TARGETS],
    tools: tools as NeutralTool[],
    model: scalar(data, 'model', file),
    effort: scalar(data, 'effort', file),
    owns: list(data, 'owns'),
    subagentOf: scalar(data, 'subagentOf', file),
    body,
    file,
  };
}

/**
 * Load every definition under `root`, sorted by kind then name so a render is byte-stable. An
 * unstable render would reload the plugin mid-session and can cost the user their prompt cache.
 */
export function loadDefs(root: string): AgentDef[] {
  const defs: AgentDef[] = [];
  for (const [kind, dir] of Object.entries(KIND_DIRS) as Array<[DefKind, string]>) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) {
      continue;
    }
    for (const entry of fs.readdirSync(abs).sort()) {
      if (!entry.endsWith('.md')) {
        continue;
      }
      const rel = path.posix.join(dir, entry);
      defs.push(parseDef(kind, rel, fs.readFileSync(path.join(abs, entry), 'utf8')));
    }
  }

  const seen = new Map<string, string>();
  for (const def of defs) {
    const previous = seen.get(def.name);
    if (previous !== undefined) {
      throw new DefError(def.file, `duplicate definition name '${def.name}' (also in ${previous})`);
    }
    seen.set(def.name, def.file);
  }

  const byName = new Map(defs.map(def => [def.name, def]));
  for (const def of defs) {
    for (const owned of def.owns) {
      const target = byName.get(owned);
      if (!target) {
        throw new DefError(def.file, `owns '${owned}', which is not a definition`);
      }
      if (target.kind === 'agent') {
        throw new DefError(def.file, `owns '${owned}', which is an agent — owns takes skills`);
      }
    }
    if (def.subagentOf !== undefined && byName.get(def.subagentOf)?.kind !== 'agent') {
      throw new DefError(def.file, `subagentOf '${def.subagentOf}' is not an agent`);
    }
  }

  return defs.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}
