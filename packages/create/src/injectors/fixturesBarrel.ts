import path from 'node:path';

import type { PluginManifest } from '../manifest.js';
import { readText, writeText } from '../util/fs.js';
import { addToRegion, hasRegion, removeFromRegion } from '../util/markers.js';

type Fixture = NonNullable<PluginManifest['fixture']>;

function barrelPath(clientDir: string): string {
  return path.join(clientDir, 'fixtures', 'index.ts');
}

function importLine(f: Fixture): string {
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
 * Splice a plugin's fixture into fixtures/index.ts: its import plus a `mergeTests` arg (if it ships a
 * test object) and/or a `mergeExpects` arg (if it ships matchers). Independent — a matcher-only plugin
 * touches only imports+expects. Returns false if a needed managed marker is missing so the caller can
 * print a paste block instead of half-editing.
 */
export function applyFixture(clientDir: string, m: PluginManifest): boolean {
  const f = m.fixture;
  if (!f) {
    return true;
  }
  const file = barrelPath(clientDir);
  let src = readText(file);
  if (!hasRegion(src, 'plugins:imports')) {
    return false;
  }
  if (f.test && !hasRegion(src, 'plugins:tests')) {
    return false;
  }
  if (f.expect && !hasRegion(src, 'plugins:expects')) {
    return false;
  }
  src = addToRegion(src, 'plugins:imports', importLine(f), f.importFrom);
  if (f.test) {
    src = addToRegion(src, 'plugins:tests', `  ${f.test.alias},`, `${f.test.alias},`);
  }
  if (f.expect) {
    src = addToRegion(src, 'plugins:expects', `  ${f.expect.alias},`, `${f.expect.alias},`);
  }
  writeText(file, src);
  return true;
}

/** Reverse applyFixture. */
export function removeFixture(clientDir: string, m: PluginManifest): void {
  const f = m.fixture;
  if (!f) {
    return;
  }
  const file = barrelPath(clientDir);
  let src = readText(file);
  src = removeFromRegion(src, 'plugins:imports', f.importFrom);
  if (f.test) {
    src = removeFromRegion(src, 'plugins:tests', `${f.test.alias},`);
  }
  if (f.expect) {
    src = removeFromRegion(src, 'plugins:expects', `${f.expect.alias},`);
  }
  writeText(file, src);
}
