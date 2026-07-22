import { copyDocs, copyExamples } from './injectors/assets.js';
import { mergePluginEnv, removePluginEnv } from './injectors/envJson.js';
import { applyFixture, removeFixture } from './injectors/fixturesBarrel.js';
import { mergePluginPackageJson, removePluginPackageJson } from './injectors/packageJson.js';
import { applyProject, removeProject } from './injectors/pwConfig.js';
import { loadPluginManifest, type PluginManifest } from './manifest.js';
import { findKnownPlugin } from './registry.js';
import { log } from './util/log.js';
import { run } from './util/run.js';

/** Resolve plugin ids/packages to npm package names via the known-plugins registry. */
function toPackages(pluginIds: string[]): string[] {
  return pluginIds
    .map(id => findKnownPlugin(id)?.package ?? (id.startsWith('@') ? id : undefined))
    .filter((p): p is string => Boolean(p));
}

/** Run all injectors for one plugin manifest. Warns (does not throw) when a marker is missing. */
function injectManifest(clientDir: string, m: PluginManifest, testsDir: string): void {
  mergePluginPackageJson(clientDir, m);
  mergePluginEnv(clientDir, m);
  copyExamples(clientDir, m, testsDir);
  copyDocs(clientDir, m);

  if (applyFixture(clientDir, m) === false) {
    log.warn(
      `fixtures/index.ts is missing a pwtap marker — wire ${m.name} into the barrel manually ` +
        `(import from '${m.fixture?.importFrom}' and add to mergeTests/mergeExpects).`,
    );
  }
  if (applyProject(clientDir, m) === false) {
    log.warn(
      `playwright.config.ts is missing a pwtap marker — add this project manually:\n  ${m.playwrightProject?.gate}`,
    );
  }
}

/** Best-effort post-install host check (advisory — never throws). */
async function runEnsure(clientDir: string, m: PluginManifest): Promise<void> {
  if (!m.ensure) {
    return;
  }
  try {
    const { createRequire } = await import('node:module');
    const { pathToFileURL } = await import('node:url');
    const require = createRequire(`${clientDir}/`);
    const resolved = require.resolve(`${m.name}/${m.ensure}`, { paths: [clientDir] });
    const mod = (await import(pathToFileURL(resolved).href)) as { ensure?: () => Promise<void> };
    await mod.ensure?.();
  } catch (err) {
    log.warn(
      `${m.name} ensure() check skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface AddOptions {
  clientDir: string;
  pluginIds: string[];
  install: boolean;
  /** The project's tests folder (default 'tests') — where plugin example specs are copied. */
  testsDir?: string;
}

export async function addPlugins({
  clientDir,
  pluginIds,
  install,
  testsDir = 'tests',
}: AddOptions): Promise<void> {
  const packages = toPackages(pluginIds);
  if (packages.length === 0) {
    return;
  }
  if (install) {
    log.step(`Installing plugin${packages.length > 1 ? 's' : ''}: ${packages.join(', ')}`);
    await run('npm', ['install', '-D', ...packages], { cwd: clientDir });
  }
  for (const pkg of packages) {
    const m = await loadPluginManifest(clientDir, pkg);
    if (!m) {
      log.warn(`Could not load manifest for ${pkg} — is it installed? Skipping.`);
      continue;
    }
    injectManifest(clientDir, m, testsDir);
    await runEnsure(clientDir, m);
    log.done(`Added ${pkg}`);
  }
  // Reconcile: install any devDependencies the plugin manifests added to package.json.
  if (install) {
    await run('npm', ['install'], { cwd: clientDir });
  }
}

export interface RemoveOptions {
  clientDir: string;
  pluginIds: string[];
  uninstall?: boolean;
}

export async function removePlugins({
  clientDir,
  pluginIds,
  uninstall = true,
}: RemoveOptions): Promise<void> {
  const packages = toPackages(pluginIds);
  for (const pkg of packages) {
    const m = await loadPluginManifest(clientDir, pkg);
    if (!m) {
      log.warn(`Could not load manifest for ${pkg} — skipping (already removed?).`);
      continue;
    }
    removeFixture(clientDir, m);
    removeProject(clientDir, m);
    removePluginEnv(clientDir, m);
    removePluginPackageJson(clientDir, m);
    log.done(`Removed ${pkg}`);
  }
  if (uninstall && packages.length > 0) {
    await run('npm', ['uninstall', ...packages], { cwd: clientDir });
  }
}
