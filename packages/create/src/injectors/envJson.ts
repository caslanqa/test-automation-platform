import path from 'node:path';

import type { PluginManifest } from '../manifest.js';
import { exists, readJson, writeJson } from '../util/fs.js';

interface EnvFile {
  common?: Record<string, unknown>;
  environments?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/** Both env files if present — the tracked example and the gitignored real one. */
function envFiles(clientDir: string): string[] {
  return [
    path.join(clientDir, 'env', 'environments.json'),
    path.join(clientDir, 'env', 'environments.example.json'),
  ].filter(exists);
}

/** Add a plugin's env keys under `common` (loadEnv flattens them into process.env). Skips existing keys. */
export function mergePluginEnv(clientDir: string, m: PluginManifest): void {
  if (Object.keys(m.envKeys).length === 0) {
    return;
  }
  for (const file of envFiles(clientDir)) {
    const cfg = readJson<EnvFile>(file);
    cfg.common = { ...(cfg.common ?? {}) };
    for (const [key, value] of Object.entries(m.envKeys)) {
      if (!(key in cfg.common)) {
        cfg.common[key] = value;
      }
    }
    writeJson(file, cfg);
  }
}

/** Reverse mergePluginEnv: drop the plugin's env keys from `common`. */
export function removePluginEnv(clientDir: string, m: PluginManifest): void {
  for (const file of envFiles(clientDir)) {
    const cfg = readJson<EnvFile>(file);
    if (!cfg.common) {
      continue;
    }
    for (const key of Object.keys(m.envKeys)) {
      delete cfg.common[key];
    }
    writeJson(file, cfg);
  }
}
