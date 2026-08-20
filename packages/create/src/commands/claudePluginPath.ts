/**
 * `create-pwtap claude-plugin-path` — the marketplace `command` source entry point.
 *
 * The contract Claude Code enforces: **exactly one line on stdout**, an absolute path to a directory
 * holding a complete plugin, and exit 0. So this module has exactly one `process.stdout.write` and
 * everything diagnostic goes to stderr.
 *
 * Hard rule for anyone editing this path: never call `log.info`, `log.step` or `log.done`. They are
 * `console.info`, which is stdout, and one of them here breaks the contract silently for every user.
 * `packages/create/test/agentsStdout.test.ts` is what catches that.
 *
 * @example
 * $ npx create-pwtap claude-plugin-path
 * /Users/me/.pwtap/claude-plugin/checkout-tests-9f2a1c04
 */
import fs from 'node:fs';
import path from 'node:path';

import { detect } from '../agents/capabilities.js';
import { loadDefs } from '../agents/defs.js';
import { outDirFor } from '../agents/outDir.js';
import { resolveProject } from '../agents/project.js';
import { renderClaudePlugin } from '../agents/renderClaude.js';
import { log } from '../util/log.js';

export interface ClaudePluginPathOptions {
  /** Directory holding the neutral definition source (`<pkgRoot>/agents`). */
  agentsDir: string;
  /** `@pwtap/create`'s own version, read from its package.json by the caller. */
  version: string;
  /** `--project <dir>`, when given. */
  project?: string;
}

/** Files copied into the plugin verbatim, as `[sourceRelativeToAgentsDir, destinationInPlugin]`. */
const EXTRAS: Array<[string, string]> = [
  ['hooks/hooks.json', 'hooks/hooks.json'],
  ['hooks/check-markers.mjs', 'hooks/check-markers.mjs'],
];

export async function claudePluginPathCommand(options: ClaudePluginPathOptions): Promise<void> {
  const { agentsDir, version, project } = options;

  const resolved = resolveProject(project);
  const capabilities = resolved.dir === null ? null : await detect(resolved.dir);
  if (resolved.dir !== null && capabilities === null) {
    log.warn(
      `${resolved.dir} (from ${resolved.source}) is not a pwtap project — rendering the core-only roster.`,
    );
  }

  const result = renderClaudePlugin({
    defs: loadDefs(agentsDir),
    capabilities,
    outDir: outDirFor(capabilities === null ? null : capabilities.projectDir),
    version,
    extras: EXTRAS.map(([source, destination]) => [path.join(agentsDir, source), destination]),
  });

  for (const warning of result.warnings) {
    log.warn(warning);
  }

  // Never print a path we already know Claude Code will refuse. This guards a coding regression,
  // not a user state: both entries are emitted unconditionally.
  const manifest = path.join(result.outDir, '.claude-plugin', 'plugin.json');
  const skills = path.join(result.outDir, 'skills');
  if (!fs.existsSync(manifest) || !fs.existsSync(skills)) {
    throw new Error(
      `[pwtap] rendered plugin at ${result.outDir} is incomplete — refusing to print it`,
    );
  }

  process.stdout.write(`${result.outDir}\n`);
}
