import path from 'node:path';

import type { PluginManifest } from '../manifest.js';
import { readJson, sortObject, writeJson } from '../util/fs.js';
import { readTestsDir, remapTestsDirInScript } from '../util/testsDir.js';

interface PackageJson {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * A plugin's scripts with any `tests/…` path pointed at the project's actual tests folder.
 *
 * A manifest has to name something, and `tests` is the default — but `create --tests-dir e2e` renamed it, so
 * `@pwtap/plugin-perf`'s `playwright test tests/perf` would run against a folder that does not exist and report
 * "no tests found", which reads like the plugin failed to install. Example destinations were already rewritten;
 * script values were not, and plugin-perf is the first plugin whose script names a test path.
 *
 * Read from the client's package.json rather than threaded in, so `add` and `remove` cannot disagree: removal
 * matches a script by value, and a mismatch would leave it behind.
 */
function scriptsFor(clientDir: string, m: PluginManifest): Record<string, string> {
  const testsDir = readTestsDir(clientDir);
  return Object.fromEntries(
    Object.entries(m.scripts).map(([key, value]) => [key, remapTestsDirInScript(value, testsDir)]),
  );
}

const MOBILE_PLUGINS = ['@pwtap/plugin-maestro', '@pwtap/plugin-appium'] as const;

function hasOtherMobilePlugin(pkg: PackageJson, removing: string): boolean {
  return MOBILE_PLUGINS.some(name => {
    if (name === removing) {
      return false;
    }
    return Boolean(pkg.devDependencies?.[name] || pkg.dependencies?.[name]);
  });
}

/** Merge a plugin's scripts + devDependencies into the client package.json (never clobbering user keys wins — plugin values overwrite only same-named keys). */
export function mergePluginPackageJson(clientDir: string, m: PluginManifest): void {
  const file = path.join(clientDir, 'package.json');
  const pkg = readJson<PackageJson>(file);
  pkg.scripts = sortObject({ ...(pkg.scripts ?? {}), ...scriptsFor(clientDir, m) });
  pkg.devDependencies = sortObject({ ...(pkg.devDependencies ?? {}), ...m.devDependencies });
  writeJson(file, pkg);
}

/** Reverse mergePluginPackageJson: drop the plugin's scripts/devDeps and the plugin package itself. */
export function removePluginPackageJson(clientDir: string, m: PluginManifest): void {
  const file = path.join(clientDir, 'package.json');
  const pkg = readJson<PackageJson>(file);
  // The same rewrite `add` applied, or the value comparison below never matches and the script survives removal.
  const injected = scriptsFor(clientDir, m);
  for (const key of Object.keys(m.scripts)) {
    if (
      (key === 'mobile:create-device' ||
        key === 'mobile:stop-devices' ||
        key === 'mobile:inspect') &&
      hasOtherMobilePlugin(pkg, m.name)
    ) {
      continue;
    }
    // Keep a same-named script if another plugin/user has already overridden it.
    if (pkg.scripts?.[key] === injected[key]) {
      delete pkg.scripts[key];
    }
  }
  for (const key of Object.keys(m.devDependencies)) {
    delete pkg.devDependencies?.[key];
  }
  delete pkg.devDependencies?.[m.name];
  delete pkg.dependencies?.[m.name];
  writeJson(file, pkg);
}
