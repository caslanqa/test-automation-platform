/**
 * Removes build output so the next build cannot leave orphans behind.
 *
 * `tsc -b` emits, it does not prune: a deleted or moved source leaves its `.js`/`.d.ts`/`.map` in `dist`
 * forever. That shipped `dist/electron/*` in `@pwtap/mobile-inspector` long after ADR-001 removed Electron —
 * dead modules importing a package that is not a dependency. The `tsbuildinfo` goes too, or `tsc` considers
 * the deleted output up to date and emits nothing.
 *
 * @example node scripts/clean.mjs            # every workspace package
 * @example node scripts/clean.mjs packages/mobile-inspector
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = ['dist', 'ui-dist', 'tsconfig.tsbuildinfo'];

const targets =
  process.argv.length > 2
    ? process.argv.slice(2).map(dir => path.resolve(dir))
    : fs
        .readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(ROOT, 'packages', entry.name));

for (const dir of targets) {
  for (const artifact of ARTIFACTS) {
    const target = path.join(dir, artifact);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      console.log(`  removed ${path.relative(ROOT, target)}`);
    }
  }
}
