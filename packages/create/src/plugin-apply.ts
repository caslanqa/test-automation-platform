import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { copyDocs, copyExamples } from './injectors/assets.js';
import { mergePluginEnv, removePluginEnv } from './injectors/envJson.js';
import { applyFixture, removeFixture } from './injectors/fixturesBarrel.js';
import { orphanedExamples } from './injectors/orphanedExamples.js';
import { mergePluginPackageJson, removePluginPackageJson } from './injectors/packageJson.js';
import {
  applyProject,
  applyReporter,
  removeProject,
  removeReporter,
} from './injectors/pwConfig.js';
import { applyReadme, removeReadme } from './injectors/readme.js';
import { fixtureList, loadPluginManifest, type PluginManifest } from './manifest.js';
import { findKnownPlugin, KNOWN_PLUGINS } from './registry.js';
import { ensureDir, exists, readJson, writeJson, writeText } from './util/fs.js';
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
  applyReadme(clientDir, m);

  if (applyFixture(clientDir, m) === false) {
    const sources = fixtureList(m)
      .map(f => `'${f.importFrom}'`)
      .join(', ');
    log.warn(
      `fixtures/index.ts is missing a pwtap marker — wire ${m.name} into the barrel manually ` +
        `(import from ${sources} and add to mergeTests/mergeExpects).`,
    );
  }
  if (applyProject(clientDir, m) === false) {
    log.warn(
      `playwright.config.ts is missing a pwtap marker — add this project manually:\n  ${m.playwrightProject?.gate}`,
    );
  }
  // A project scaffolded before the `plugins:reporters` region existed has no marker to splice into,
  // so say exactly what to paste rather than editing half of the array.
  if (applyReporter(clientDir, m) === false) {
    log.warn(
      `playwright.config.ts has no 'pwtap:plugins:reporters' region — add this to its reporter array manually:\n${m.reporter?.line}`,
    );
  }
}

interface EnvFile {
  common?: Record<string, unknown>;
  [key: string]: unknown;
}

function envFiles(clientDir: string): string[] {
  return [
    path.join(clientDir, 'env', 'environments.json'),
    path.join(clientDir, 'env', 'environments.example.json'),
  ].filter(exists);
}

function ensureEnvJsonExists(clientDir: string): void {
  const envDir = path.join(clientDir, 'env');
  const envJson = path.join(envDir, 'environments.json');
  const envExample = path.join(envDir, 'environments.example.json');
  if (exists(envJson)) {
    return;
  }
  if (exists(envExample)) {
    writeText(envJson, `${JSON.stringify(readJson<EnvFile>(envExample), null, 2)}\n`);
    return;
  }
  ensureDir(envDir);
  writeJson(envJson, { common: {}, environments: {} });
}

function findAndroidSdkRoot(): string | undefined {
  const home = os.homedir();
  const direct = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    process.platform === 'darwin' ? path.join(home, 'Library', 'Android', 'sdk') : undefined,
    process.platform === 'linux' ? path.join(home, 'Android', 'Sdk') : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : undefined,
  ]
    .filter((dir): dir is string => Boolean(dir))
    .find(dir => exists(dir));
  if (direct) {
    return direct;
  }
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const adb = execFileSync(whichCmd, ['adb'], { encoding: 'utf8' }).split('\n')[0]?.trim();
    if (!adb) {
      return undefined;
    }
    const normalized = adb.replace(/\\/g, '/');
    const marker = '/platform-tools/';
    const idx = normalized.lastIndexOf(marker);
    if (idx > 0) {
      const sdk = normalized.slice(0, idx);
      if (exists(sdk)) {
        return sdk;
      }
    }
  } catch {
    // best-effort detection only
  }
  return undefined;
}

function needsAndroidSdk(manifests: PluginManifest[]): boolean {
  return manifests.some(m => m.id === 'maestro' || m.id === 'appium');
}

function hasMobilePlugin(manifests: PluginManifest[]): boolean {
  return manifests.some(m => m.id === 'maestro' || m.id === 'appium');
}

function hasAppiumPlugin(manifests: PluginManifest[]): boolean {
  return manifests.some(m => m.id === 'appium');
}

function ensureMobileHelperScripts(clientDir: string, manifests: PluginManifest[]): void {
  if (!hasMobilePlugin(manifests)) {
    return;
  }
  const mobileDir = path.join(clientDir, 'scripts', 'mobile');
  ensureDir(mobileDir);

  const createDevice = `#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const appiumScript = path.join(root, 'node_modules', '@pwtap', 'plugin-appium', 'bin', 'create-device.mjs');
const maestroScript = path.join(root, 'node_modules', '@pwtap', 'plugin-maestro', 'bin', 'create-device.mjs');
const script = existsSync(appiumScript) ? appiumScript : existsSync(maestroScript) ? maestroScript : null;

if (!script) {
  console.error('No mobile plugin installed. Install @pwtap/plugin-appium or @pwtap/plugin-maestro.');
  process.exit(1);
}
const res = spawnSync(process.execPath, [script, ...process.argv.slice(2)], { stdio: 'inherit' });
if (res.error) {
  console.error(res.error.message);
  process.exit(1);
}
process.exit(res.status ?? 0);
`;

  const stopDevices = `#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const appiumScript = path.join(root, 'node_modules', '@pwtap', 'plugin-appium', 'bin', 'stop-devices.mjs');
const maestroScript = path.join(root, 'node_modules', '@pwtap', 'plugin-maestro', 'bin', 'stop-devices.mjs');
const script = existsSync(appiumScript) ? appiumScript : existsSync(maestroScript) ? maestroScript : null;

if (!script) {
  console.error('No mobile plugin installed. Install @pwtap/plugin-appium or @pwtap/plugin-maestro.');
  process.exit(1);
}
const res = spawnSync(process.execPath, [script, ...process.argv.slice(2)], { stdio: 'inherit' });
if (res.error) {
  console.error(res.error.message);
  process.exit(1);
}
process.exit(res.status ?? 0);
`;

  writeText(path.join(mobileDir, 'create-device.mjs'), createDevice);
  writeText(path.join(mobileDir, 'stop-devices.mjs'), stopDevices);

  if (hasAppiumPlugin(manifests)) {
    const appiumReport = `#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const binScript = path.join(root, 'node_modules', '@pwtap', 'plugin-appium', 'bin', 'appium-report.mjs');
const templateScript = path.join(root, 'node_modules', '@pwtap', 'plugin-appium', 'templates', 'scripts', 'mobile', 'appium-report.mjs');
const script = existsSync(binScript) ? binScript : existsSync(templateScript) ? templateScript : null;

if (!script) {
  console.error('Appium report generator not found. Reinstall @pwtap/plugin-appium.');
  process.exit(1);
}
const res = spawnSync(process.execPath, [script, ...process.argv.slice(2)], { stdio: 'inherit' });
if (res.error) {
  console.error(res.error.message);
  process.exit(1);
}
process.exit(res.status ?? 0);
`;
    writeText(path.join(mobileDir, 'appium-report.mjs'), appiumReport);
  }
}

function syncAndroidSdkEnv(clientDir: string, manifests: PluginManifest[]): void {
  if (!needsAndroidSdk(manifests)) {
    return;
  }
  ensureEnvJsonExists(clientDir);

  const sdkRoot = findAndroidSdkRoot();
  if (!sdkRoot) {
    log.warn(
      'Android SDK not detected. Install Android Studio / command-line tools, then set ' +
        '`ANDROID_SDK_ROOT` (and optionally `ANDROID_HOME`) in env/environments.json under common.',
    );
    return;
  }

  const touched: string[] = [];
  for (const file of envFiles(clientDir)) {
    const cfg = readJson<EnvFile>(file);
    const common = { ...(cfg.common ?? {}) };
    const root = typeof common.ANDROID_SDK_ROOT === 'string' ? common.ANDROID_SDK_ROOT.trim() : '';
    const home = typeof common.ANDROID_HOME === 'string' ? common.ANDROID_HOME.trim() : '';
    let changed = false;
    if (!root) {
      common.ANDROID_SDK_ROOT = sdkRoot;
      changed = true;
    }
    if (!home) {
      common.ANDROID_HOME = sdkRoot;
      changed = true;
    }
    if (changed) {
      cfg.common = common;
      writeJson(file, cfg);
      touched.push(path.relative(clientDir, file));
    }
  }

  if (touched.length > 0) {
    log.info(
      `[mobile] Detected Android SDK at '${sdkRoot}' and wrote ANDROID_SDK_ROOT/ANDROID_HOME to: ${touched.join(
        ', ',
      )}`,
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
  const loaded: PluginManifest[] = [];
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
    loaded.push(m);
    injectManifest(clientDir, m, testsDir);
    await runEnsure(clientDir, m);
    log.done(`Added ${pkg}`);
  }
  ensureMobileHelperScripts(clientDir, loaded);
  syncAndroidSdkEnv(clientDir, loaded);
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

/**
 * The `importFrom` values of shared fixtures that plugins OTHER than `removing` still contribute.
 *
 * A shared fixture (today: the driver-neutral `mobileApp` facade, provided by both mobile plugins) lives
 * in the barrel once. Removing one contributor must not delete it while another is still installed, or
 * every remaining test that uses it fails with an unknown-fixture error. Probing the registry is how we
 * find the survivors: `loadPluginManifest` returns null for a package that isn't installed.
 */
async function sharedFixturesToKeep(
  clientDir: string,
  removing: readonly string[],
): Promise<Set<string>> {
  const keep = new Set<string>();
  for (const known of KNOWN_PLUGINS) {
    if (removing.includes(known.package)) {
      continue;
    }
    const m = await loadPluginManifest(clientDir, known.package);
    for (const f of m ? fixtureList(m) : []) {
      if (f.shared) {
        keep.add(f.importFrom);
      }
    }
  }
  return keep;
}

export async function removePlugins({
  clientDir,
  pluginIds,
  uninstall = true,
}: RemoveOptions): Promise<void> {
  const packages = toPackages(pluginIds);
  const keepShared = await sharedFixturesToKeep(clientDir, packages);
  /** Where each removed plugin put its examples — its own footprint, declared rather than guessed. */
  const installedDirs: string[] = [];
  for (const pkg of packages) {
    const m = await loadPluginManifest(clientDir, pkg);
    if (!m) {
      log.warn(`Could not load manifest for ${pkg} — skipping (already removed?).`);
      continue;
    }
    installedDirs.push(...(m.examples ?? []).map(example => example.dest));
    removeFixture(clientDir, m, keepShared);
    removeProject(clientDir, m);
    removeReporter(clientDir, m);
    removeReadme(clientDir, m);
    removePluginEnv(clientDir, m);
    removePluginPackageJson(clientDir, m);
    log.done(`Removed ${pkg}`);
  }
  if (uninstall && packages.length > 0) {
    await run('npm', ['uninstall', ...packages], { cwd: clientDir });
  }
  // The plugin's example tests are left on disk on purpose — a user may have built their suite on them —
  // but the files it installed, and anything importing it, stop the project compiling — so name them. An import
  // scan alone found one of six when `db` was removed: the rest imported knex/mongodb, which left with the
  // plugin, or used a fixture that vanished from the barrel while importing only `@fixtures`.
  const orphaned = orphanedExamples(clientDir, packages, installedDirs);
  if (orphaned.length > 0) {
    log.warn(
      `${orphaned.length} file(s) belong to ${packages.join(', ')} and most will no longer compile:\n${orphaned
        .map(file => `    ${file}`)
        .join(
          '\n',
        )}\n  They were left in place in case you edited them — delete or move them when you are done.`,
    );
  }
}
