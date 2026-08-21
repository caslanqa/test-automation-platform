/**
 * What a consumer project actually has, expressed as the token set the `requires` predicates read.
 *
 * This is the piece that makes "no mobile plugin installed, no mobile agent" true. Claude Code has
 * no conditional component loading, so gating happens here, at render time.
 *
 * Installation is decided by **resolution, not by `devDependencies`**: a plugin listed but not
 * resolvable means `npm install` is still pending, and enabling its agents there hands the model
 * scripts that do not work. The probe is the same one `sharedFixturesToKeep()` uses in
 * plugin-apply.ts — `loadPluginManifest` returns null for a package that is not installed.
 *
 * @example
 * const caps = await detect('/path/to/project');
 * caps?.tokens.has('cap:mobile'); // true when appium or maestro resolves
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadPluginManifest, type PluginManifest } from '../manifest.js';
import { KNOWN_PLUGINS } from '../registry.js';
import { readTestsDir } from '../util/testsDir.js';

export interface ProjectCapabilities {
  /** Absolute path to the project root. */
  projectDir: string;
  /** The project's tests folder, as recorded at scaffold time. */
  testsDir: string;
  /** Installed plugins, keyed by `manifest.id`. Only resolvable ones appear. */
  plugins: Record<string, PluginManifest>;
  /** The project's npm script names — feeds `{{script:…}}` interpolation, never gating. */
  scripts: string[];
  /** `core`, `plugin:<id>` and `cap:<name>` — what `evaluateRequires` reads. */
  tokens: Set<string>;
  /** Non-fatal findings worth telling the user about (a devDep that is not installed yet). */
  warnings: string[];
}

interface ClientPackageJson {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  pwtap?: { testsDir?: string };
}

function readClientPackageJson(projectDir: string): ClientPackageJson | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'),
    ) as ClientPackageJson;
  } catch {
    return null;
  }
}

/**
 * Is this a pwtap project at all? Three independent signals, because each one alone has a false
 * negative: a project can drop the `pwtap` key, and a brand-new scaffold has neither installed
 * dependencies nor a recorded testsDir until `npm install` finishes.
 */
function looksLikePwtapProject(projectDir: string, pkg: ClientPackageJson): boolean {
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  return (
    pkg.pwtap !== undefined ||
    declared['@playwright/test'] !== undefined ||
    fs.existsSync(path.join(projectDir, 'playwright.config.ts'))
  );
}

/** Whether the config still names the allure reporter, which `read-run-artifacts` depends on. */
function hasAllureReporter(projectDir: string): boolean {
  try {
    return fs
      .readFileSync(path.join(projectDir, 'playwright.config.ts'), 'utf8')
      .includes('allure-playwright');
  } catch {
    return false;
  }
}

/**
 * Read a project's capabilities, or `null` when it is not a pwtap project — which is a baseline
 * render, not an error. Nothing here throws: the caller may be a marketplace command whose failure
 * would break a session start.
 */
export async function detect(projectDir: string): Promise<ProjectCapabilities | null> {
  const absolute = path.resolve(projectDir);
  const pkg = readClientPackageJson(absolute);
  if (!pkg || !looksLikePwtapProject(absolute, pkg)) {
    return null;
  }

  const plugins: Record<string, PluginManifest> = {};
  const warnings: string[] = [];
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const known of KNOWN_PLUGINS) {
    const manifest = await loadPluginManifest(absolute, known.package);
    if (manifest) {
      plugins[manifest.id] = manifest;
    } else if (declared[known.package] !== undefined) {
      warnings.push(
        `${known.package} is in package.json but does not resolve — run 'npm install'. ` +
          `Its agents and skills are omitted until it does.`,
      );
    }
  }

  const tokens = new Set<string>(['core']);
  for (const id of Object.keys(plugins)) {
    tokens.add(`plugin:${id}`);
  }
  // Derived tokens. Four, and each one gates a real component — see docs/agentic-vv-plan.md.
  if (tokens.has('plugin:appium') || tokens.has('plugin:maestro')) {
    tokens.add('cap:mobile');
  }
  if (fs.existsSync(path.join(absolute, '.github', 'workflows'))) {
    tokens.add('cap:ci-github');
  }
  if (hasAllureReporter(absolute)) {
    tokens.add('cap:allure');
  }
  if (fs.existsSync(path.join(absolute, '.git'))) {
    tokens.add('cap:git');
  }

  return {
    projectDir: absolute,
    testsDir: readTestsDir(absolute),
    plugins,
    scripts: Object.keys(pkg.scripts ?? {}),
    tokens,
    warnings,
  };
}
