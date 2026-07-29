/**
 * Discovers installed mobile plugin driver adapters at runtime, without scanning the filesystem or
 * executing arbitrary packages — mirrors `@pwtap/create`'s `loadPluginManifest` pattern: resolve a
 * package's stable `"./inspector"` export from the caller's own `node_modules`, then import it.
 *
 * Both `@pwtap/plugin-maestro` and `@pwtap/plugin-appium` are optional peers of this package: neither
 * is a hard dependency, so a project with only one installed still works, and a project with neither
 * installed simply reports an empty driver list (the UI/fixture surface a clear error instead of a
 * module-resolution crash).
 *
 * An adapter whose declared contract this core does not accept is skipped and reported through
 * `onProblem` instead of loaded (ADR-009): a version mismatch must name the package to upgrade rather
 * than resurface later as a missing method on a driver.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { adapterContractProblem } from './contract.js';
import type { MobileInspectorDriver } from './types.js';

/** A package known to expose a mobile inspector driver adapter via its `"./inspector"` export. */
const KNOWN_ADAPTER_PACKAGES = ['@pwtap/plugin-maestro', '@pwtap/plugin-appium'] as const;

interface InspectorModule {
  driver?: MobileInspectorDriver;
  /** The contract the adapter was built against — a literal in the adapter's own source. */
  contract?: number;
}

/** Reports an adapter that is installed but unusable, so no such failure is silent. */
export type AdapterProblemReporter = (message: string) => void;

/**
 * Resolve one package's `./inspector` export from `baseDir`'s `node_modules`. Returns `null` when the
 * package isn't installed, doesn't expose an inspector adapter, or declares an unsupported contract —
 * never throws, so callers can probe every known package unconditionally.
 */
async function loadDriverFrom(
  baseDir: string,
  pkg: string,
  onProblem?: AdapterProblemReporter,
): Promise<MobileInspectorDriver | null> {
  let mod: InspectorModule;
  try {
    const require = createRequire(`${baseDir}/`);
    const resolved = require.resolve(`${pkg}/inspector`, { paths: [baseDir] });
    mod = (await import(pathToFileURL(resolved).href)) as InspectorModule;
  } catch {
    // Not installed, or its `./inspector` entry does not resolve. Probing every known package is how
    // discovery works, so neither is worth reporting.
    return null;
  }
  if (!mod.driver) {
    return null;
  }
  const problem = adapterContractProblem(pkg, mod.contract);
  if (problem) {
    onProblem?.(problem);
    return null;
  }
  return mod.driver;
}

/**
 * Discover every installed driver adapter, resolved relative to `baseDir` (defaults to
 * `process.cwd()` — the scaffolded project running the inspector). Order matches
 * {@link KNOWN_ADAPTER_PACKAGES}.
 */
export async function discoverDrivers(
  baseDir: string = process.cwd(),
  onProblem?: AdapterProblemReporter,
): Promise<MobileInspectorDriver[]> {
  const results = await Promise.all(
    KNOWN_ADAPTER_PACKAGES.map(pkg => loadDriverFrom(baseDir, pkg, onProblem)),
  );
  return results.filter((driver): driver is MobileInspectorDriver => driver !== null);
}

/** Discover drivers and index them by id for `O(1)` lookup (e.g. from `test.use({ mobile: { driver } })`). */
export async function discoverDriverMap(
  baseDir: string = process.cwd(),
  onProblem?: AdapterProblemReporter,
): Promise<Map<string, MobileInspectorDriver>> {
  const drivers = await discoverDrivers(baseDir, onProblem);
  return new Map(drivers.map(driver => [driver.id, driver]));
}
