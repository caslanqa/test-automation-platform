/**
 * A test's identity across runs.
 *
 * **Not `TestCase.id`.** Playwright documents that as unique within a *session*, and it hashes
 * file + title + project opaquely; using it as a history key would silently lose a test's past the
 * moment anything about the session changed. `TestCase.id` is still recorded, but only to cross-link
 * the HTML report.
 *
 * The semantics, each chosen deliberately:
 *
 * - **project is included** — the same title on `chromium` and `webkit` are different tests with
 *   different flake profiles.
 * - **`repeatEachIndex` is excluded** — it is a CLI knob, not identity. Including it would fragment
 *   every test's history under `--repeat-each`.
 * - **`retry` is excluded** — retries are attempts of one test. That is what `AttemptRecord` is for,
 *   and conflating them is the bug in the shipped appium report.
 * - **the file is hashed separately from the title path**, so rename detection stays possible later.
 * - **a rename produces a new key, on purpose.** Renaming a test is an edit to the spec; its flake
 *   history is no longer about the same behaviour. `heal history rename` exists for the rare
 *   deliberate case and appends to the baseline rather than mutating it silently.
 *
 * @example
 * testKey('chromium', 'tests/checkout.spec.ts', ['checkout', 'shows the total']);
 * // → '9f2a1c04e5b6d7a8'
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

/** Playwright's `titlePath()` is `['', project, file, ...describes, title]`; we want the tail. */
export function titlePathAfterFile(titlePath: readonly string[], file: string): string[] {
  const base = path.basename(file);
  for (let i = titlePath.length - 1; i >= 0; i -= 1) {
    const entry = titlePath[i];
    if (entry === file || path.basename(entry) === base) {
      return titlePath.slice(i + 1);
    }
  }
  // No file entry to anchor on (a synthetic suite, or a shape we have not seen): drop the leading
  // empty root entry and keep the rest, which is still stable for the same test.
  return titlePath.filter((entry, index) => !(index === 0 && entry === ''));
}

export function testKey(
  project: string,
  relativeFile: string,
  titlePathAfterFileEntry: readonly string[],
): string {
  return createHash('sha1')
    .update([project, relativeFile, ...titlePathAfterFileEntry].join('\0'))
    .digest('hex')
    .slice(0, 16);
}
