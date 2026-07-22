import { removePlugins } from '../plugin-apply.js';

export interface RemoveCommandOptions {
  clientDir: string;
  pluginIds: string[];
}

/** `create-pwtap remove <plugin…>` — reverse every injection and uninstall the plugin package(s). */
export async function removeCommand(opts: RemoveCommandOptions): Promise<void> {
  if (opts.pluginIds.length === 0) {
    throw new Error('remove: name at least one plugin, e.g. `npx create-pwtap remove maestro`');
  }
  await removePlugins({ clientDir: opts.clientDir, pluginIds: opts.pluginIds });
}
