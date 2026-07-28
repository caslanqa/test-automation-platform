import path from 'node:path';

import { fixtureList, type ManifestFixture, type PluginManifest } from '../manifest.js';
import { readText, writeText } from '../util/fs.js';
import { addToRegion, hasRegion, removeFromRegion } from '../util/markers.js';

function barrelPath(clientDir: string): string {
  return path.join(clientDir, 'fixtures', 'index.ts');
}

function importLine(f: ManifestFixture): string {
  const parts: string[] = [];
  if (f.test) {
    parts.push(`${f.test.export ?? 'test'} as ${f.test.alias}`);
  }
  if (f.expect) {
    parts.push(`${f.expect.export ?? 'expect'} as ${f.expect.alias}`);
  }
  return `import { ${parts.join(', ')} } from '${f.importFrom}';`;
}

/**
 * Splice a plugin's fixtures into fixtures/index.ts: for each one, its import plus a `mergeTests` arg (if
 * it ships a test object) and/or a `mergeExpects` arg (if it ships matchers). Independent — a
 * matcher-only plugin touches only imports+expects. Insertion is idempotent (`addToRegion` skips a line
 * already present), so a fixture contributed by two plugins lands exactly once. Returns false if a needed
 * managed marker is missing so the caller can print a paste block instead of half-editing.
 */
export function applyFixture(clientDir: string, m: PluginManifest): boolean {
  const fixtures = fixtureList(m);
  if (fixtures.length === 0) {
    return true;
  }
  const file = barrelPath(clientDir);
  let src = readText(file);
  if (!hasRegion(src, 'plugins:imports')) {
    return false;
  }
  if (fixtures.some(f => f.test) && !hasRegion(src, 'plugins:tests')) {
    return false;
  }
  if (fixtures.some(f => f.expect) && !hasRegion(src, 'plugins:expects')) {
    return false;
  }
  for (const f of fixtures) {
    src = addToRegion(src, 'plugins:imports', importLine(f), f.importFrom);
    if (f.test) {
      src = addToRegion(src, 'plugins:tests', `  ${f.test.alias},`, `${f.test.alias},`);
    }
    if (f.expect) {
      src = addToRegion(src, 'plugins:expects', `  ${f.expect.alias},`, `${f.expect.alias},`);
    }
  }
  writeText(file, src);
  return true;
}

/**
 * Reverse {@link applyFixture}.
 *
 * `keepShared` lists the `importFrom` values that other still-installed plugins also contribute. A
 * fixture marked `shared` whose import is in that set is left untouched: removing one mobile plugin while
 * the other remains must not strip the `mobileApp` fixture out from under the tests that still use it.
 */
export function removeFixture(
  clientDir: string,
  m: PluginManifest,
  keepShared: ReadonlySet<string> = new Set(),
): void {
  const fixtures = fixtureList(m).filter(f => !(f.shared && keepShared.has(f.importFrom)));
  if (fixtures.length === 0) {
    return;
  }
  const file = barrelPath(clientDir);
  let src = readText(file);
  // Removal is cleanup, so a region the user has since deleted is simply nothing left to clean — it must
  // not abort an uninstall with a MarkerError.
  const strip = (region: string, uniq: string): void => {
    if (hasRegion(src, region)) {
      src = removeFromRegion(src, region, uniq);
    }
  };
  for (const f of fixtures) {
    strip('plugins:imports', f.importFrom);
    if (f.test) {
      strip('plugins:tests', `${f.test.alias},`);
    }
    if (f.expect) {
      strip('plugins:expects', `${f.expect.alias},`);
    }
  }
  writeText(file, src);
}
