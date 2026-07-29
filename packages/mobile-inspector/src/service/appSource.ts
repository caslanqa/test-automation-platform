/**
 * Validates the `appSource` the UI supplies before it reaches an adapter or an installer (ADR-010).
 *
 * The value ends up at `adb install` / `simctl install` or Appium's `app` capability, and the browser
 * chooses it, so it is checked here rather than trusted: an existing local artifact with an allowed
 * extension, or an `https:` URL. Only the inspector's path needs this — a test's own `mobileTarget.appSource`
 * is the test author's code and is not an untrusted input.
 *
 * @example await resolveAppSource('./build/app.apk', root) // → { appSource: '/…/build/app.apk' }
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** `.app` is a directory bundle, not a file, which is why existence is checked with `stat`. */
const ALLOWED_EXTENSIONS = ['.apk', '.app', '.ipa', '.zip'];

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export type AppSourceResult = { appSource: string } | { error: string };

/**
 * Resolve and validate an artifact location. Relative paths resolve against the project root — the same
 * base the placeholder in the UI implies — and the normalised absolute path is what gets forwarded, so the
 * adapter never has to guess which directory a relative path was meant to be relative to.
 */
export async function resolveAppSource(
  value: string,
  projectRoot: string,
): Promise<AppSourceResult> {
  const trimmed = value.trim();
  if (!trimmed) {
    return { error: 'no app artifact specified' };
  }

  if (HAS_SCHEME.test(trimmed)) {
    // `http:` is refused too: this downloads an artifact and installs it on a device, so it does not
    // travel over a connection anyone on the path can rewrite.
    return trimmed.toLowerCase().startsWith('https:')
      ? { appSource: trimmed }
      : { error: `app artifact URL must be https: — got "${trimmed}"` };
  }

  const extension = ALLOWED_EXTENSIONS.find(candidate => trimmed.toLowerCase().endsWith(candidate));
  if (!extension) {
    return {
      error: `app artifact must be one of ${ALLOWED_EXTENSIONS.join(', ')} — got "${trimmed}"`,
    };
  }

  const absolute = path.resolve(projectRoot, trimmed);
  const stats = await fs.stat(absolute).catch(() => undefined);
  if (!stats) {
    return { error: `app artifact not found: ${absolute}` };
  }
  // A `.apk`/`.ipa`/`.zip` is a file and a `.app` is a bundle directory; anything else (a socket, a
  // device node) is not an artifact whatever it is named.
  const wellFormed = extension === '.app' ? stats.isDirectory() : stats.isFile();
  return wellFormed
    ? { appSource: absolute }
    : {
        error: `app artifact is not a ${extension === '.app' ? 'bundle directory' : 'file'}: ${absolute}`,
      };
}
