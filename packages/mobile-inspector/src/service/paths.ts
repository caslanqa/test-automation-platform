/**
 * Path confinement for every filesystem operation the service performs on behalf of the browser UI
 * (architecture.md ADR-010). Two holes this closes: a prefix test alone lets `/proj-evil` pass as
 * inside `/proj`, and resolving without `realpath` lets a symlinked directory read or write outside
 * the project entirely.
 *
 * @example await resolveInsideProject('/proj', '../etc/passwd') // → undefined
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** The real path if it resolves, else the input — a path that does not exist yet is not an error here. */
async function realpathOrSelf(target: string): Promise<string> {
  return fs.realpath(target).catch(() => target);
}

/**
 * Resolve a project-relative path and return its canonical form, or `undefined` when it escapes the
 * project. Paths that do not exist yet are allowed: the deepest existing ancestor is the one checked,
 * and the remaining segments are appended to its real path so the result never leads through a symlink.
 */
export async function resolveInsideProject(
  projectRoot: string,
  relative: string,
): Promise<string | undefined> {
  const root = await realpathOrSelf(path.resolve(projectRoot));
  const target = path.resolve(root, relative);

  let ancestor = target;
  while (path.dirname(ancestor) !== ancestor) {
    if (
      await fs.stat(ancestor).then(
        () => true,
        () => false,
      )
    ) {
      break;
    }
    ancestor = path.dirname(ancestor);
  }
  const real = await realpathOrSelf(ancestor);
  if (real !== root && !real.startsWith(root + path.sep)) {
    return undefined;
  }
  return path.join(real, path.relative(ancestor, target));
}
