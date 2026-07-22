import path from 'node:path';

import type { PluginManifest } from '../manifest.js';
import { readJson, sortObject, writeJson } from '../util/fs.js';

interface PackageJson {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

/** Merge a plugin's scripts + devDependencies into the client package.json (never clobbering user keys wins — plugin values overwrite only same-named keys). */
export function mergePluginPackageJson(clientDir: string, m: PluginManifest): void {
  const file = path.join(clientDir, 'package.json');
  const pkg = readJson<PackageJson>(file);
  pkg.scripts = sortObject({ ...(pkg.scripts ?? {}), ...m.scripts });
  pkg.devDependencies = sortObject({ ...(pkg.devDependencies ?? {}), ...m.devDependencies });
  writeJson(file, pkg);
}

/** Reverse mergePluginPackageJson: drop the plugin's scripts/devDeps and the plugin package itself. */
export function removePluginPackageJson(clientDir: string, m: PluginManifest): void {
  const file = path.join(clientDir, 'package.json');
  const pkg = readJson<PackageJson>(file);
  for (const key of Object.keys(m.scripts)) {
    delete pkg.scripts?.[key];
  }
  for (const key of Object.keys(m.devDependencies)) {
    delete pkg.devDependencies?.[key];
  }
  delete pkg.devDependencies?.[m.name];
  delete pkg.dependencies?.[m.name];
  writeJson(file, pkg);
}
