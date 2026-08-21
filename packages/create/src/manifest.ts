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
/** One entry spliced into the `@fixtures` barrel: an import plus a mergeTests/mergeExpects argument. */
export interface ManifestFixture {
  importFrom: string;
  /** Composable test object merged via mergeTests. Omit for matcher-only plugins (e.g. ai-judge). */
  test?: { export?: string; alias: string };
  /** Custom-matcher `expect` merged via mergeExpects. Omit for fixture-only plugins (e.g. maestro). */
  expect?: { export?: string; alias: string };
  /**
   * True when OTHER plugins may contribute this same fixture. Adding it stays idempotent either way
   * (the barrel injector dedupes), but removal must not: uninstalling one mobile plugin while the other
   * is still installed must leave the shared `mobileApp` fixture in place, or every remaining
   * inspector-generated test breaks with an unknown-fixture error.
   */
  shared?: boolean;
}

/**
 * One MCP server a plugin brings, declared rather than injected.
 *
 * Shaped like {@link ManifestFixture} on purpose, `shared` included: both mobile plugins bring the same
 * server, and removing one while the other is installed must leave it declared.
 *
 * **Nothing is written to the client's repository for this.** The configuration is *derived* at render
 * time from the manifests that resolve, so add/remove symmetry comes free: `create-pwtap remove maestro`
 * deletes the manifest, the next render skips the server, and there is no marker region, no removal path
 * and no idempotence test to get wrong. That is the whole reason the agent plugin uses a rendered
 * directory rather than an injected file.
 */
export interface ManifestMcpServer {
  /** The name the client sees, e.g. `mobile`. */
  name: string;
  /** The package holding the entry — resolved from the CLIENT's node_modules, never ours. */
  package: string;
  /** Package-relative path to the executable entry, e.g. `bin/mcp.mjs`. */
  entry: string;
  /** True when another plugin may bring the same server; the renderer dedupes by `name`. */
  shared?: boolean;
}

export interface PluginManifest {
  id: string;
  name: string;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  envKeys: Record<string, string>;
  /**
   * One fixture, or several. A plugin usually contributes exactly one, but a mobile plugin also brings
   * the shared driver-neutral `mobileApp` fixture, which both mobile plugins provide — hence the array
   * form plus {@link ManifestFixture.shared}.
   */
  fixture?: ManifestFixture | ManifestFixture[];
  playwrightProject?: {
    gateVar: string;
    gate: string;
    project: string;
    globalTeardown?: string;
  };
  /**
   * One entry spliced into `playwright.config.ts`'s `reporter` array. Shaped like
   * {@link PluginManifest.playwrightProject} so add/remove symmetry is inherited: `uniq` is the
   * removal match key (the analogue of `gateVar`) and `line` is the literal, indented as it should
   * appear in the array.
   */
  reporter?: { uniq: string; line: string };
  /** MCP servers this plugin makes available. Derived into the rendered agent plugin, never injected. */
  mcp?: ManifestMcpServer[];
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

/** Normalize the one-or-many `fixture` field to a list. */
export function fixtureList(m: PluginManifest): ManifestFixture[] {
  if (!m.fixture) {
    return [];
  }
  return Array.isArray(m.fixture) ? m.fixture : [m.fixture];
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
