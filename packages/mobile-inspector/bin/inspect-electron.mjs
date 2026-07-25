#!/usr/bin/env node
/**
 * CLI launcher for the Electron Mobile Inspector. Resolves the local Electron binary and spawns the
 * built main process (`dist/electron/main.js`) with the target project root, so the privileged main
 * process discovers that project's installed plugins/adapters. Usage:
 * `node bin/inspect-electron.mjs [projectDir]` (defaults to the current working directory).
 *
 * This is the Electron replacement for the browser-based `bin/inspect.mjs`; the loopback HTTP/WS
 * launcher is kept alongside it until the `electron-packaging` milestone removes that surface.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const projectRoot = path.resolve(process.argv[2] ?? process.cwd());
const mainEntry = path.resolve(here, '../dist/electron/main.js');

// `electron` exports the path to its platform binary as the module's default string export.
const electronBinary = require('electron');

const child = spawn(electronBinary, [mainEntry], {
  stdio: 'inherit',
  env: { ...process.env, PWTAP_INSPECTOR_PROJECT_ROOT: projectRoot },
});

child.on('exit', code => process.exit(code ?? 0));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
