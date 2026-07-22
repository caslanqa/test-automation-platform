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
  await addPlugins(opts);
}
