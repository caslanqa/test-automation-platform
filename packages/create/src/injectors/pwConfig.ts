import path from 'node:path';

import type { PluginManifest } from '../manifest.js';
import { readText, writeText } from '../util/fs.js';
import { addToRegion, hasRegion, removeFromRegion } from '../util/markers.js';

function configPath(clientDir: string): string {
  return path.join(clientDir, 'playwright.config.ts');
}

/**
 * Splice a plugin's env gate and project spread into playwright.config.ts. Returns false if a managed
 * marker is missing (caller then prints a paste block). Each project is env-gated so a bare
 * `npm test` stays UI + API only.
 */
export function applyProject(clientDir: string, m: PluginManifest): boolean {
  const pp = m.playwrightProject;
  if (!pp) {
    return true;
  }
  const file = configPath(clientDir);
  let src = readText(file);
  if (!hasRegion(src, 'plugins:gates') || !hasRegion(src, 'plugins:projects')) {
    return false;
  }
  src = addToRegion(src, 'plugins:gates', pp.gate, pp.gateVar);
  const projectLine = `    ${pp.project.replace(/,\s*$/, '')},`;
  src = addToRegion(src, 'plugins:projects', projectLine, pp.gateVar);
  writeText(file, src);
  return true;
}

/** Reverse applyProject (matches on the gate variable name). */
export function removeProject(clientDir: string, m: PluginManifest): void {
  const pp = m.playwrightProject;
  if (!pp) {
    return;
  }
  const file = configPath(clientDir);
  let src = readText(file);
  src = removeFromRegion(src, 'plugins:gates', pp.gateVar);
  src = removeFromRegion(src, 'plugins:projects', pp.gateVar);
  writeText(file, src);
}

/**
 * Splice a plugin's reporter into playwright.config.ts's `reporter` array. Returns false if the
 * managed marker is missing (caller then prints a paste block), which is the case for every project
 * scaffolded before the `plugins:reporters` region existed — those users get instructions rather
 * than a half-edit.
 */
export function applyReporter(clientDir: string, m: PluginManifest): boolean {
  const reporter = m.reporter;
  if (!reporter) {
    return true;
  }
  const file = configPath(clientDir);
  const src = readText(file);
  if (!hasRegion(src, 'plugins:reporters')) {
    return false;
  }
  writeText(file, addToRegion(src, 'plugins:reporters', reporter.line, reporter.uniq));
  return true;
}

/**
 * Reverse applyReporter (matches on `uniq`).
 *
 * Sharp edge worth knowing: if a user hand-pinned the reporter OUTSIDE the marker region, this
 * cannot remove it, and Playwright then fails the whole run on an unresolvable reporter module once
 * the package is uninstalled. That is Playwright's behaviour rather than ours, and `removePlugins`
 * says so in its warning.
 */
export function removeReporter(clientDir: string, m: PluginManifest): void {
  const reporter = m.reporter;
  if (!reporter) {
    return;
  }
  const file = configPath(clientDir);
  const src = readText(file);
  if (!hasRegion(src, 'plugins:reporters')) {
    return;
  }
  writeText(file, removeFromRegion(src, 'plugins:reporters', reporter.uniq));
}
