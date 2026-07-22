import fs from 'node:fs';
import path from 'node:path';

import { addPlugins } from '../plugin-apply.js';

export interface AddCommandOptions {
  clientDir: string;
  pluginIds: string[];
  install: boolean;
}

/** `create-pwtap add <plugin…>` — install and wire one or more plugins into an existing project. */
export async function addCommand(opts: AddCommandOptions): Promise<void> {
  if (opts.pluginIds.length === 0) {
    throw new Error('add: name at least one plugin, e.g. `npx create-pwtap add maestro`');
  }
  await addPlugins({ ...opts, testsDir: readTestsDir(opts.clientDir) });
}

/** Read the project's tests folder recorded at scaffold time (`pwtap.testsDir`); defaults to 'tests'. */
function readTestsDir(clientDir: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(clientDir, 'package.json'), 'utf8')) as {
      pwtap?: { testsDir?: string };
    };
    const dir = pkg.pwtap?.testsDir;
    return typeof dir === 'string' && dir.length > 0 ? dir : 'tests';
  } catch {
    return 'tests';
  }
}
