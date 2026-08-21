/**
 * `create-pwtap mcp` — print the MCP server configuration for this project.
 *
 * **It prints; it never writes.** A `.mcp.json` we generated would be a file we own forever in someone
 * else's repository: committed, drifting, and needing a removal path, an idempotence test and a marker
 * region to be safe. A block the user pastes is a block the user owns. The only supported automatic
 * route is the rendered Claude Code plugin, where the configuration is *derived* at render time from the
 * plugins that are installed — so `create-pwtap remove maestro` un-declares the server by itself, with
 * nothing to undo.
 *
 * The path points at the project's **own** installed copy of the inspector, never `npx`. A globally
 * npx-ed inspector runs against this project's adapters, and `registry.ts` checks each adapter against
 * `MOBILE_CORE_CONTRACT` — the version skew ADR-009 exists to refuse. Run the copy the project already
 * installed, or run nothing.
 *
 * @example
 * npx @pwtap/create mcp        # prints an mcpServers block to paste into any MCP client
 */
import { createRequire } from 'node:module';
import path from 'node:path';

import { log } from '../util/log.js';

/** The inspector's MCP entry, resolved from the CLIENT's node_modules, or null when it is not there. */
function resolveServerEntry(clientDir: string): string | null {
  try {
    // Same probe shape as `loadPluginManifest` and `loadDriverFrom`: resolution, not a declared
    // dependency, because a devDependency that was never installed cannot run anything.
    const require = createRequire(path.join(clientDir, 'package.json'));
    require.resolve('@pwtap/mobile-inspector/mcp');
    return path.join(clientDir, 'node_modules', '@pwtap', 'mobile-inspector', 'bin', 'mcp.mjs');
  } catch {
    return null;
  }
}

export interface McpCommandOptions {
  clientDir: string;
}

export async function mcpCommand(options: McpCommandOptions): Promise<void> {
  const clientDir = path.resolve(options.clientDir);
  const entry = resolveServerEntry(clientDir);

  if (entry === null) {
    log.warn(
      '@pwtap/mobile-inspector is not installed here, so there is no MCP server to configure yet.',
    );
    log.warn('Add a mobile plugin first:  npx @pwtap/create add maestro   (or: add appium)');
    return;
  }

  const config = {
    mcpServers: {
      mobile: {
        // `node` and an absolute path, not `node_modules/.bin/mobile-mcp`: a `.bin` entry is a shell
        // shim on POSIX and a `.cmd` on Windows, and an MCP `command` is not run through a shell.
        command: 'node',
        args: [entry, clientDir],
        env: {
          PWTAP_MCP_IDLE_MS: '600000',
          PWTAP_MCP_ALLOW_ACTIONS: '0',
        },
      },
    },
  };

  // The one and only stdout write, so the output can be piped straight into a file by the user if they
  // decide they want one.
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);

  log.warn('');
  log.warn('Paste the block above into your MCP client (Claude Code: .mcp.json in this project).');
  log.warn('Nothing was written — the file is yours, not ours.');
  log.warn(
    'PWTAP_MCP_ALLOW_ACTIONS=0 keeps mobile_perform listed but refusing; set it to 1 to let a session touch the device.',
  );
}
