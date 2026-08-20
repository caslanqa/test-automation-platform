/**
 * `create-pwtap init-agents` — write the same rendered components straight into a project's
 * `.claude/` directory, with no plugin and no marketplace.
 *
 * This is the documented fallback for the three cases the `command` marketplace source cannot serve:
 * Claude Code older than 2.1.229, an organisation whose managed settings block command plugin
 * sources, and a machine with no network at session start. It is a **static snapshot** — re-run it
 * after `create-pwtap add` or `remove`, because nothing re-renders it for you.
 *
 * Naming and flags mirror `playwright init-agents --loop=<x>` on purpose; that is the ergonomics
 * users already know.
 *
 * @example
 * $ npx create-pwtap init-agents --loop=claude
 */
import path from 'node:path';

import { detect } from '../agents/capabilities.js';
import { loadDefs } from '../agents/defs.js';
import { recordProject } from '../agents/project.js';
import { renderClaudePlugin } from '../agents/renderClaude.js';
import { log } from '../util/log.js';

/** Loops the compiler can emit. `agents-md` and `copilot` are a later phase, and say so. */
const LOOPS = ['claude', 'agents-md', 'copilot', 'all'] as const;
type Loop = (typeof LOOPS)[number];

export interface InitAgentsOptions {
  agentsDir: string;
  version: string;
  projectDir: string;
  loop: string;
}

export async function initAgentsCommand(options: InitAgentsOptions): Promise<void> {
  const { agentsDir, version, projectDir } = options;
  const loop = options.loop as Loop;
  if (!LOOPS.includes(loop)) {
    throw new Error(
      `init-agents: unknown --loop '${options.loop}'. Expected one of: ${LOOPS.join(', ')}`,
    );
  }
  if (loop === 'agents-md' || loop === 'copilot') {
    throw new Error(
      `init-agents: --loop=${loop} is not implemented yet — only --loop=claude is. The definitions ` +
        `already carry a 'targets' field for it, so this is a renderer, not a format change.`,
    );
  }

  const capabilities = await detect(projectDir);
  if (capabilities === null) {
    throw new Error(
      `init-agents: ${projectDir} is not a @pwtap project (no playwright.config.ts, no ` +
        `@playwright/test, no pwtap settings). Run this from a scaffolded project.`,
    );
  }

  const outDir = path.join(capabilities.projectDir, '.claude');
  const result = renderClaudePlugin({
    defs: loadDefs(agentsDir),
    capabilities,
    outDir,
    version,
    standalone: true,
  });

  for (const warning of result.warnings) {
    log.warn(warning);
  }

  recordProject(capabilities.projectDir);

  const counted = (kind: string): number => result.included.filter(def => def.kind === kind).length;
  log.done(
    `Wrote ${counted('agent')} agents, ${counted('skill')} skills and ${counted('command')} commands to .claude/`,
  );
  if (result.excluded.length > 0) {
    log.info(
      `  ${result.excluded.length} more appear once their plugin is installed — see .claude/pwtap-vv-roster.md`,
    );
  }
  log.info(
    [
      '',
      'These are project-level components, so they are invoked bare: /vv, @vv-lead.',
      'They are a static snapshot — re-run this after `create-pwtap add` or `remove`.',
      '',
      'On Claude Code 2.1.229 or newer, prefer the plugin: it re-renders itself every session.',
      '  /plugin marketplace add caslanqa/test-automation-platform',
      '  /plugin install pwtap@pwtap',
    ].join('\n'),
  );
}
