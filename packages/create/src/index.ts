#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { addCommand } from './commands/add.js';
import { createProject } from './commands/create.js';
import { removeCommand } from './commands/remove.js';
import { KNOWN_PLUGINS } from './registry.js';
import { log } from './util/log.js';

// Package root (this file compiles to dist/index.js). template/ and core-manifest.json are bundled
// alongside dist/ at prepack, so both live at the package root.
const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const templateDir = path.join(pkgRoot, 'template');
const coreManifestPath = path.join(pkgRoot, 'core-manifest.json');

/** True if `--flag` is on argv, or npm surfaced it via `npm_config_<flag>` (so `npm init` flags work). */
function flagPresent(argv: string[], flag: string): boolean {
  if (argv.includes(flag)) {
    return true;
  }
  const key = `npm_config_${flag.replace(/^--/, '').replace(/-/g, '_')}`;
  const value = process.env[key];
  return value !== undefined && value !== '' && value !== 'false';
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const positional = argv.filter(a => !a.startsWith('-'));
  const command = positional[0] === 'add' || positional[0] === 'remove' ? positional[0] : 'create';

  const yes = flagPresent(argv, '--yes') || argv.includes('-y');
  const install = !flagPresent(argv, '--no-install');
  const browsers = !flagPresent(argv, '--no-browsers');
  const pluginIdsFromFlags = KNOWN_PLUGINS.filter(p => flagPresent(argv, p.flag)).map(p => p.id);

  if (command === 'add') {
    const ids = positional.slice(1).length > 0 ? positional.slice(1) : pluginIdsFromFlags;
    await addCommand({ clientDir: process.cwd(), pluginIds: ids, install });
    return;
  }
  if (command === 'remove') {
    await removeCommand({ clientDir: process.cwd(), pluginIds: positional.slice(1) });
    return;
  }

  const targetDir = path.resolve(process.cwd(), positional[0] ?? '.');
  await createProject({
    targetDir,
    yes,
    install,
    browsers,
    selectedPluginIds: pluginIdsFromFlags,
    templateDir,
    coreManifestPath,
  });
}

main().catch(err => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
