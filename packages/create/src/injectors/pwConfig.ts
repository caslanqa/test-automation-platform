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
