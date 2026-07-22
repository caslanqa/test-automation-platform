import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { readJson } from './util/fs.js';

/**
 * The authoritative manifest a plugin ships (compiled to `dist/manifest.js`, exported via the
 * package's `"./manifest"` entry). @pwtap/create loads it AFTER installing the plugin to know what
 * to inject into the client project.
 *
 * @example
 * export const manifest: PluginManifest = {
 *   id: 'maestro', name: '@pwtap/plugin-maestro',
 *   devDependencies: {}, scripts: { 'test:maestro': 'MAESTRO=1 playwright test --project=maestro' },
 *   envKeys: { MOBILE_PLATFORM: 'android' },
 *   fixture: { importFrom: '@pwtap/plugin-maestro', test: { alias: 'maestroTest' } },
 * };
 */
export interface PluginManifest {
  id: string;
  name: string;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  envKeys: Record<string, string>;
  fixture?: {
    importFrom: string;
    /** Composable test object merged via mergeTests. Omit for matcher-only plugins (e.g. ai-judge). */
    test?: { export?: string; alias: string };
    /** Custom-matcher `expect` merged via mergeExpects. Omit for fixture-only plugins (e.g. maestro). */
    expect?: { export?: string; alias: string };
  };
  playwrightProject?: {
    gateVar: string;
    gate: string;
    project: string;
    globalTeardown?: string;
  };
  examples?: Array<{ src: string; dest: string }>;
  docs?: Array<{ src: string; dest: string }>;
  readmeSection?: string;
  /** Package-relative path to a compiled module exporting `async ensure(): Promise<void>` (advisory). */
  ensure?: string;
}

/** The base package.json scripts/devDeps and Playwright browsers the core scaffold writes. */
export interface CoreManifest {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
  browsers: string[];
  /** Extra fields merged verbatim into the generated package.json (e.g. lint-staged, commitizen config). */
  packageJson?: Record<string, unknown>;
}

export function loadCoreManifest(coreManifestPath: string): CoreManifest {
  return readJson<CoreManifest>(coreManifestPath);
}

/**
 * Load an installed plugin's manifest by resolving `<pkg>/manifest` from the client's node_modules.
 * Returns `null` when the package or its manifest export can't be resolved (caller warns and skips).
 */
export async function loadPluginManifest(
  clientDir: string,
  pkg: string,
): Promise<PluginManifest | null> {
  try {
    const require = createRequire(`${clientDir}/`);
    const resolved = require.resolve(`${pkg}/manifest`, { paths: [clientDir] });
    const mod = (await import(pathToFileURL(resolved).href)) as { manifest?: PluginManifest };
    return mod.manifest ?? null;
  } catch {
    return null;
  }
}
