#!/usr/bin/env node
/**
 * Default CLI entrypoint for the Mobile Inspector. Spawns the packaged Electron binary with the
 * built main process (`dist/electron/main.js`) and passes the target project root through the
 * environment so the privileged main process can discover that project's adapters/plugins.
 *
 * Usage: `mobile-inspect [projectDir]`
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const projectRoot = path.resolve(process.argv[2] ?? process.cwd());
const mainEntry = path.resolve(here, '../dist/electron/main.js');
const electronBinary = require('electron');

const child = spawn(electronBinary, [mainEntry], {
  stdio: 'inherit',
  env: { ...process.env, PWTAP_INSPECTOR_PROJECT_ROOT: projectRoot },
});

child.on('exit', code => process.exit(code ?? 0));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
