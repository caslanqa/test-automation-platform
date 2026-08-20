import { recordProject } from '../agents/project.js';
import { addPlugins } from '../plugin-apply.js';
import { log } from '../util/log.js';
import { readTestsDir } from '../util/testsDir.js';

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
  // The agent renderer runs from the user's home directory and cannot see a session's cwd, so this
  // is one of the few moments we know for certain which project the user means.
  recordProject(opts.clientDir);
  log.info(
    '  Claude Code: your pwtap agents refresh on the next session (or run `/reload-plugins`).',
  );
}
