/**
 * This package must not need an optional peer's declarations to build.
 *
 * `escalate/client.ts` and `heal/mobile/target.ts` reach `@pwtap/plugin-ai-judge` and
 * `@pwtap/mobile-core` through a guarded `await import()`, and both define a **structural** copy of the
 * slice they use (`JudgeKit`, `MobileKit`) so that neither package is a build-time dependency. A literal
 * specifier undoes that silently: TypeScript resolves it, the peer's `dist/index.d.ts` becomes required
 * to compile, and nothing complains — until it does.
 *
 * It did. `changeset publish` runs every package's `prepack` in parallel, each one cleaning its own
 * `dist` before rebuilding, and this package's `tsc -b` landed in the window where the two peers had no
 * declarations. `error TS2307`, `@pwtap/plugin-heal` failed to publish, and the other nine packages in
 * that release shipped without it.
 *
 * So the rule is asserted rather than commented: no source file here may name a `@pwtap` package in an
 * import at all. The runtime checks (`typeof kit.judgeFetch === 'function'`) are the real contract, and
 * they keep working whatever version is installed — which a version range could not express anyway.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src');

/**
 * Strip comments before scanning.
 *
 * The doc comments in the very files this guards *describe* the problem, quoting the specifiers they
 * warn against — so a naive scan reports the explanation as the offence.
 */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith('.ts') ? [full] : [];
  });
}

test('no source file imports a @pwtap package, statically or with a literal dynamic specifier', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const source = withoutComments(fs.readFileSync(file, 'utf8'));
    // `from '@pwtap/…'`, `import '@pwtap/…'`, and `import('@pwtap/…')` — the last is the one that broke
    // a release, because it looks like a runtime-only reference and is not.
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"](@pwtap\/[^'"]+)['"]/g)) {
      offenders.push(`${path.relative(SRC, file)} → ${match[1]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these make an optional peer a build-time dependency; hold the specifier in a variable instead:\n  ${offenders.join('\n  ')}`,
  );
});

test('the specifiers are still the real package names', () => {
  // The variable indirection defeats the compiler, so nothing else would catch a typo in them.
  const client = fs.readFileSync(path.join(SRC, 'escalate', 'client.ts'), 'utf8');
  const target = fs.readFileSync(path.join(SRC, 'heal', 'mobile', 'target.ts'), 'utf8');
  assert.match(client, /JUDGE_PACKAGE = '@pwtap\/plugin-ai-judge'/);
  assert.match(target, /MOBILE_CORE_PACKAGE = '@pwtap\/mobile-core'/);
});
