/**
 * The project's tests folder, and rewriting a plugin's `tests/…` references onto it.
 *
 * `create --tests-dir e2e` renames the folder and records the choice in the client's own package.json
 * (`pwtap.testsDir`), so `add` run months later still knows where tests live. Anything a plugin manifest declares
 * in terms of `tests/` has to be rewritten before it lands, or the plugin quietly assumes a folder that is not
 * there.
 *
 * Both rewrites read the same recorded value, which is what keeps `add` and `remove` symmetrical: `remove` deletes
 * a script only when its value still matches what was injected, so the two must agree on the rewrite or removal
 * silently leaves the script behind.
 *
 * @example
 * remapTestsDirInScript('playwright test tests/perf --workers=1', 'e2e'); // → 'playwright test e2e/perf …'
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_TESTS_DIR = 'tests';

/** Read the project's tests folder as recorded at scaffold time; defaults to `tests`. */
export function readTestsDir(clientDir: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(clientDir, 'package.json'), 'utf8')) as {
      pwtap?: { testsDir?: string };
    };
    const dir = pkg.pwtap?.testsDir;
    return typeof dir === 'string' && dir.length > 0 ? dir : DEFAULT_TESTS_DIR;
  } catch {
    return DEFAULT_TESTS_DIR;
  }
}

/** Rewrite a `tests/…` asset destination onto the project's chosen tests folder. */
export function remapTestsDirPath(dest: string, testsDir: string): string {
  if (testsDir === DEFAULT_TESTS_DIR || dest === testsDir) {
    return dest;
  }
  if (dest === DEFAULT_TESTS_DIR) {
    return testsDir;
  }
  return dest.startsWith(`${DEFAULT_TESTS_DIR}/`)
    ? `${testsDir}${dest.slice(DEFAULT_TESTS_DIR.length)}`
    : dest;
}

/**
 * Rewrite `tests/…` paths inside an npm script value.
 *
 * Scripts are commands, not paths, so this replaces `tests` only where it starts a path argument — at the beginning
 * of the string or after whitespace, a quote or an `=` — **and is followed by a `/`**. The trailing slash is what
 * keeps it from touching a value that merely reads like the folder: `playwright test --grep tests` is a pattern,
 * and rewriting it would silently change what a script matches. No manifest names the bare folder, so requiring the
 * slash costs nothing and removes the only false positive.
 *
 * Catches `playwright test tests/perf`, `eslint "tests/**\/*.ts"` and `--dir=tests/x`; leaves
 * `npm run test:perf` and `node scripts/tests-helper.mjs` alone.
 */
export function remapTestsDirInScript(script: string, testsDir: string): string {
  if (testsDir === DEFAULT_TESTS_DIR) {
    return script;
  }
  // A replacer function, not a replacement string: `$` in a folder name is a substitution token there (`$&`, `$1`),
  // so `--tests-dir 'e2e$1'` would splice the match back in instead of writing the folder the user asked for.
  return script.replace(
    new RegExp(`(^|[\\s"'=])${DEFAULT_TESTS_DIR}(?=/)`, 'g'),
    (_match, prefix: string) => `${prefix}${testsDir}`,
  );
}
