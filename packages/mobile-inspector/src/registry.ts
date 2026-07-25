/**
 * Discovers installed mobile plugin driver adapters at runtime, without scanning the filesystem or
 * executing arbitrary packages — mirrors `@pwtap/create`'s `loadPluginManifest` pattern: resolve a
 * package's stable `"./inspector"` export from the caller's own `node_modules`, then import it.
 *
 * Both `@pwtap/plugin-maestro` and `@pwtap/plugin-appium` are optional peers of this package: neither
 * is a hard dependency, so a project with only one installed still works, and a project with neither
 * installed simply reports an empty driver list (the UI/fixture surface a clear error instead of a
 * module-resolution crash).
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import type { MobileInspectorDriver } from './types.js';

/** A package known to expose a mobile inspector driver adapter via its `"./inspector"` export. */
const KNOWN_ADAPTER_PACKAGES = ['@pwtap/plugin-maestro', '@pwtap/plugin-appium'] as const;

interface InspectorModule {
  driver?: MobileInspectorDriver;
}

/**
 * Resolve one package's `./inspector` export from `baseDir`'s `node_modules`. Returns `null` when the
 * package isn't installed or doesn't (yet) expose an inspector adapter — never throws, so callers can
 * probe every known package unconditionally.
 */
async function loadDriverFrom(baseDir: string, pkg: string): Promise<MobileInspectorDriver | null> {
  try {
    const require = createRequire(`${baseDir}/`);
    const resolved = require.resolve(`${pkg}/inspector`, { paths: [baseDir] });
    const mod = (await import(pathToFileURL(resolved).href)) as InspectorModule;
    return mod.driver ?? null;
  } catch {
    return null;
  }
}

/**
 * Discover every installed driver adapter, resolved relative to `baseDir` (defaults to
 * `process.cwd()` — the scaffolded project running the inspector). Order matches
 * {@link KNOWN_ADAPTER_PACKAGES}.
 */
export async function discoverDrivers(
  baseDir: string = process.cwd(),
): Promise<MobileInspectorDriver[]> {
  const results = await Promise.all(
    KNOWN_ADAPTER_PACKAGES.map(pkg => loadDriverFrom(baseDir, pkg)),
  );
  return results.filter((driver): driver is MobileInspectorDriver => driver !== null);
}

/** Discover drivers and index them by id for `O(1)` lookup (e.g. from `test.use({ mobile: { driver } })`). */
export async function discoverDriverMap(
  baseDir: string = process.cwd(),
): Promise<Map<string, MobileInspectorDriver>> {
  const drivers = await discoverDrivers(baseDir);
  return new Map(drivers.map(driver => [driver.id, driver]));
}
