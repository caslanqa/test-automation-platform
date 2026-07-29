/**
 * Finds files left importing a plugin that has just been removed.
 *
 * `remove` unwires the fixture, the Playwright project, the env keys and the package, but it deliberately
 * does not delete the example tests the plugin installed — a user may have edited them or built their suite
 * on top. Silence was the wrong middle ground: the project stopped type-checking and Playwright failed to
 * load those files, with nothing saying why. So they stay on disk and get reported.
 *
 * An import scan alone finds too little. Removing `db` broke six files and the scan named one: the others
 * imported `knex`/`mongodb`, which left with the plugin, or used a fixture that vanished from the barrel while
 * importing only `@fixtures`. So the plugin's own footprint counts too — the manifest already declares exactly
 * which directories it installed, so there is nothing to guess.
 *
 * @example orphanedExamples(clientDir, ['@pwtap/plugin-db'], ['tests/db', 'db'])
 */
import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'test-results', 'playwright-report']);
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs'];

/**
 * Project-relative paths the removal leaves behind: anything still importing `packages`, plus everything under
 * `installedDirs` — the directories the plugin's manifest says it created. Sorted, `node_modules` excluded.
 */
export function orphanedExamples(
  clientDir: string,
  packages: readonly string[],
  installedDirs: readonly string[] = [],
): string[] {
  if (packages.length === 0 && installedDirs.length === 0) {
    return [];
  }
  const found: string[] = [];
  const installed = installedDirs.map(dir => dir.replace(/\/+$/, ''));
  const isInstalled = (relative: string): boolean =>
    installed.some(dir => relative === dir || relative.startsWith(`${dir}/`));
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          walk(full);
        }
      } else if (SOURCE_EXTENSIONS.some(extension => entry.name.endsWith(extension))) {
        const relative = path.relative(clientDir, full).split(path.sep).join('/');
        if (isInstalled(relative)) {
          found.push(relative);
          continue;
        }
        const source = fs.readFileSync(full, 'utf8');
        // Matches both `import … from 'pkg'` and `import('pkg/sub')`; a bare mention in a comment does not
        // break the build, so the quote is part of the match.
        if (packages.some(pkg => source.includes(`'${pkg}'`) || source.includes(`'${pkg}/`))) {
          found.push(relative);
        }
      }
    }
  };
  walk(clientDir);
  return found.sort((a, b) => a.localeCompare(b));
}
