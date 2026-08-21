#!/usr/bin/env node
/**
 * `mobile-mcp [projectDir]` — the pwtap mobile MCP server, speaking JSON-RPC on stdin/stdout.
 *
 * The project directory decides everything: `discoverDriverMap` resolves the mobile adapters out of
 * *that* project's `node_modules`, so a server pointed at the wrong directory reports no drivers at all —
 * a silent, confusing failure. Hence the explicit argument, and hence `.mcp.json` passing
 * `${CLAUDE_PROJECT_DIR}` rather than relying on the working directory.
 *
 * **Nothing may write to stdout but JSON-RPC.** A stray line corrupts the channel for the whole session,
 * so diagnostics go to stderr and `src/mcp/**` is lint-banned from `console.log`.
 *
 * Teardown hangs off **stdin EOF**, which is the only reliable "the client is gone" signal a stdio server
 * gets. `process.on('exit')` cannot await anything, so a device lock released there would never actually
 * be released. A SIGKILL leaves nothing to run at all — the backstop for that already exists, in
 * `@pwtap/platform`'s ten-minute stale-lock steal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMcpServer } from '../dist/mcp/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

const projectRoot = path.resolve(process.argv[2] ?? process.env.PWTAP_PROJECT_DIR ?? process.cwd());

const server = createMcpServer(projectRoot, version);

// One idempotent teardown for every way this process can end, with the same re-entry guard
// `bin/inspect.mjs` grew after a signal arriving mid-startup orphaned a browser.
let stopping = false;
const stop = async code => {
  if (stopping) {
    return;
  }
  stopping = true;
  await server.shutdown().catch(() => undefined);
  process.exit(code);
};

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => void stop(0));
}

server.listen(process.stdin, process.stdout, () => void stop(0));

process.stderr.write(`[pwtap-mobile-mcp] serving ${projectRoot}\n`);
