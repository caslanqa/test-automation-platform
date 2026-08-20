/**
 * Render the definitions into a Claude Code plugin directory.
 *
 * Two invariants carry the whole design:
 *
 * 1. **Only satisfied definitions are emitted.** Claude Code has no conditional component loading,
 *    so "no mobile plugin installed, no mobile agent" is enforced here or nowhere.
 * 2. **The render is deterministic.** No timestamps, no hostnames, no iteration-order dependence. A
 *    byte-different render of the same input reloads the plugin mid-session and can cost the user
 *    their prompt cache, so stability is a correctness requirement, not a nicety.
 *
 * Nothing here writes to stdout — the caller's only stdout write is the printed path.
 *
 * @example
 * const result = renderClaudePlugin({ defs, capabilities, outDir, version: '0.8.0' });
 * result.emitted; // ['agents/vv-lead.md', 'skills/spec-conventions/SKILL.md', …]
 */
import fs from 'node:fs';
import path from 'node:path';

import type { ProjectCapabilities } from './capabilities.js';
import { TOOL_MAP, type AgentDef } from './defs.js';
import { serializeFrontmatter, type Frontmatter } from './frontmatter.js';
import { evaluateRequires } from './requires.js';

export const PLUGIN_NAME = 'pwtap';

export interface RenderOptions {
  defs: AgentDef[];
  /** null when no pwtap project was resolved — a baseline, core-only render. */
  capabilities: ProjectCapabilities | null;
  outDir: string;
  /** `@pwtap/create`'s own version, so a user can tell which renderer produced a plugin. */
  version: string;
  /** Extra files to copy in verbatim, as `[absoluteSource, relativeDestination]`. */
  extras?: Array<[string, string]>;
  /**
   * Standalone mode writes the same components straight into a project's `.claude/` directory
   * instead of a plugin directory: no manifest, and no namespace prefix, because project-level
   * components are invoked bare (`/vv`, `@vv-lead`) rather than as `pwtap:vv`.
   *
   * This is the documented fallback for Claude Code older than 2.1.229, for an organisation that
   * blocks command plugin sources, and for a machine with no network at session start.
   */
  standalone?: boolean;
}

export interface RenderResult {
  outDir: string;
  /** Relative paths written, sorted. */
  emitted: string[];
  /** Definitions that were rendered. */
  included: AgentDef[];
  /** Definitions gated out, with the predicate that excluded them. */
  excluded: Array<{ def: AgentDef; requires: string }>;
  /** Non-fatal notes for stderr — an unresolved script, an unknown token, a pending install. */
  warnings: string[];
}

/** Where the roster report lands, which differs by mode and which `vv-status` has to be able to name. */
const rosterReportPath = (standalone: boolean): string =>
  standalone ? '.claude/pwtap-vv-roster.md' : '${CLAUDE_PLUGIN_ROOT}/README.md';

/** Substitute the interpolation tokens. Not a template engine, and deliberately not one. */
function interpolate(
  body: string,
  capabilities: ProjectCapabilities | null,
  warn: (message: string) => void,
  file: string,
  standalone: boolean,
  presentNames: ReadonlySet<string> = new Set(),
): string {
  const testsDir = capabilities?.testsDir ?? 'tests';
  const projectDir = capabilities?.projectDir ?? '<your project>';
  return (
    body
      .replace(/\{\{testsDir\}\}/g, testsDir)
      .replace(/\{\{projectDir\}\}/g, projectDir)
      .replace(/\{\{rosterReport\}\}/g, rosterReportPath(standalone))
      // Cross-references in prose. Hardcoding `@pwtap:x` would be wrong in standalone mode, where
      // project-level components are invoked bare.
      .replace(/\{\{ref:([a-z0-9-]+)\}\}/g, (_match, name: string) => {
        if (!presentNames.has(name)) {
          warn(`${file}: refers to '${name}', which is not in this render`);
        }
        return `@${qualify(name, standalone)}`;
      })
      .replace(/\{\{script:([A-Za-z0-9:_-]+)\}\}/g, (_match, name: string) => {
        // In a baseline render there is no project to check against, so the degraded form is the
        // expected outcome rather than a problem worth reporting.
        if (capabilities !== null && !capabilities.scripts.includes(name)) {
          warn(`${file}: references script '${name}', which this project does not have`);
        }
        return `npm run ${name}`;
      })
  );
}

/** How one component refers to another: namespaced inside a plugin, bare in a project. */
const qualify = (name: string, standalone: boolean): string =>
  standalone ? name : `${PLUGIN_NAME}:${name}`;

function frontmatterFor(
  def: AgentDef,
  ownedAndPresent: string[],
  standalone: boolean,
): Frontmatter {
  const data: Frontmatter = { name: def.name, description: def.description };
  if (def.kind === 'agent') {
    const tools = def.tools.flatMap(tool => TOOL_MAP[tool].claude);
    if (tools.length > 0) {
      data.tools = tools;
    }
    if (def.model !== undefined) {
      data.model = def.model;
    }
    if (def.effort !== undefined) {
      data.effort = def.effort;
    }
    if (ownedAndPresent.length > 0) {
      data.skills = ownedAndPresent.map(name => qualify(name, standalone));
    }
  }
  // `hooks`, `mcpServers` and `permissionMode` are never emitted: they are not supported on a
  // plugin-shipped agent, and a manifest carrying them fails `claude plugin validate --strict`.
  return data;
}

/** The delegation note, appended so an agent knows who it answers to without a declarative field. */
function delegationNote(def: AgentDef, children: AgentDef[], standalone: boolean): string {
  const lines: string[] = [];
  if (children.length > 0) {
    lines.push(
      '',
      '## Delegate to',
      '',
      ...children.map(child => `- \`@${qualify(child.name, standalone)}\` — ${child.description}`),
    );
  }
  if (def.subagentOf !== undefined) {
    lines.push(
      '',
      `Report your verdict back to \`@${qualify(def.subagentOf, standalone)}\`, which owns the overall gate.`,
    );
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function relativeDestination(def: AgentDef): string {
  switch (def.kind) {
    case 'agent':
      return path.posix.join('agents', `${def.name}.md`);
    case 'skill':
      return path.posix.join('skills', def.name, 'SKILL.md');
    case 'command':
      return path.posix.join('commands', `${def.name}.md`);
  }
}

interface ReadmeInput {
  included: AgentDef[];
  excluded: Array<{ def: AgentDef; requires: string }>;
  warnings: string[];
  version: string;
}

function readme(result: ReadmeInput, capabilities: ProjectCapabilities | null): string {
  const tokens = [...(capabilities?.tokens ?? new Set(['core']))].sort();
  const rows = (defs: AgentDef[], mark: string): string[] =>
    defs.map(def => `| ${mark} | ${def.kind} | \`${def.name}\` | \`${def.requiresSource}\` |`);

  return [
    '# pwtap V&V agents',
    '',
    'This plugin is **rendered**, not shipped as a fixed set: `create-pwtap claude-plugin-path` reads',
    'the pwtap plugins your project actually has and emits only the agents and skills those support.',
    'Install a test plugin and the matching agents appear on the next session; remove it and they go.',
    '',
    '## What was detected',
    '',
    capabilities === null
      ? [
          '**No pwtap project was resolved**, so this is the baseline, core-only roster.',
          '',
          "The renderer runs from your home directory and cannot see the session's working",
          'directory. It resolves a project from `--project`, then `PWTAP_PROJECT`, then',
          '`CLAUDE_PROJECT_DIR`, then the registry at `~/.pwtap/projects.json`. To point it at a',
          'project, set `PWTAP_PROJECT` in your shell profile, or run any `create-pwtap` command in',
          'the project once to register it.',
        ].join('\n')
      : [
          `- Project: \`${capabilities.projectDir}\``,
          `- Tests folder: \`${capabilities.testsDir}\``,
        ].join('\n'),
    '',
    `- Capability tokens: ${tokens.map(token => `\`${token}\``).join(', ')}`,
    '',
    '## Roster',
    '',
    '| | kind | name | requires |',
    '|---|---|---|---|',
    ...rows(result.included, '✓'),
    ...rows(
      result.excluded.map(entry => entry.def),
      '·',
    ),
    '',
    'A `·` row is a definition this project does not qualify for. Install the plugin its `requires`',
    'names and it appears on the next session.',
    '',
    ...(result.warnings.length > 0
      ? ['## Warnings', '', ...result.warnings.map(warning => `- ${warning}`), '']
      : []),
    `Rendered by \`@pwtap/create\` ${result.version === '' ? '(unknown version)' : result.version}.`,
    '',
  ].join('\n');
}

export function renderClaudePlugin(options: RenderOptions): RenderResult {
  const { defs, capabilities, outDir, version, extras = [], standalone = false } = options;
  const tokens = capabilities?.tokens ?? new Set(['core']);
  const warnings: string[] = [...(capabilities?.warnings ?? [])];
  const warn = (message: string): void => {
    if (!warnings.includes(message)) {
      warnings.push(message);
    }
  };

  const claudeDefs = defs.filter(def => def.targets.includes('claude'));
  const included: AgentDef[] = [];
  const excluded: Array<{ def: AgentDef; requires: string }> = [];
  for (const def of claudeDefs) {
    if (
      evaluateRequires(def.requires, tokens, token => warn(`${def.file}: unknown token '${token}'`))
    ) {
      included.push(def);
    } else {
      excluded.push({ def, requires: def.requiresSource });
    }
  }

  const presentNames = new Set(included.map(def => def.name));
  const files = new Map<string, string>();

  // Standalone mode writes project-level components, which have no manifest at all.
  if (!standalone) {
    files.set(
      path.posix.join('.claude-plugin', 'plugin.json'),
      `${JSON.stringify(
        {
          name: PLUGIN_NAME,
          displayName: 'pwtap V&V agents',
          description:
            'SDLC verification & validation agents for a @pwtap Playwright suite, rendered for the plugins this project has',
          ...(version === '' ? {} : { version }),
          author: { name: 'pwtap' },
          repository: 'https://github.com/caslanqa/test-automation-platform',
          license: 'MIT',
          keywords: ['playwright', 'testing', 'qa', 'verification'],
        },
        null,
        2,
      )}\n`,
    );
  }

  for (const def of included) {
    // An `owns:` entry whose own predicate failed must be pruned, or the emitted agent's `skills:`
    // names a component that is not in the plugin. This is not warned about: `owns` is a superset by
    // design ("I own these when they exist"), so pruning is the normal case, and warning would print
    // the same three lines on every session start of every core-only project. The README's roster
    // table is where a reader sees what was left out and why.
    const ownedAndPresent = def.owns.filter(name => presentNames.has(name));
    const children =
      def.kind === 'agent' ? included.filter(other => other.subagentOf === def.name) : [];
    const body =
      interpolate(def.body, capabilities, warn, def.file, standalone, presentNames) +
      delegationNote(def, children, standalone);
    files.set(
      relativeDestination(def),
      serializeFrontmatter(frontmatterFor(def, ownedAndPresent, standalone), body),
    );
  }

  for (const [source, destination] of extras) {
    if (fs.existsSync(source)) {
      files.set(destination, fs.readFileSync(source, 'utf8'));
    }
  }

  files.set(
    standalone ? path.basename(rosterReportPath(true)) : 'README.md',
    readme({ included, excluded, warnings, version }, capabilities),
  );

  const sorted = [...files.keys()].sort();
  if (standalone) {
    // In place, file by file, and NEVER a directory replace: `outDir` is the user's own `.claude/`,
    // which holds their agents, their skills and their settings.local.json. Only the component names
    // we emit are overwritten; anything else they put there survives a re-run.
    for (const relative of sorted) {
      const absolute = path.join(outDir, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, files.get(relative) as string);
    }
  } else {
    // Stage then swap: a reader must never see a half-written plugin, and a component whose
    // capability disappeared must not survive as a stale file.
    const staging = `${outDir}.tmp-${process.pid}`;
    fs.rmSync(staging, { recursive: true, force: true });
    for (const relative of sorted) {
      const absolute = path.join(staging, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, files.get(relative) as string);
    }
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.renameSync(staging, outDir);
  }

  return { outDir, emitted: [...files.keys()].sort(), included, excluded, warnings };
}
