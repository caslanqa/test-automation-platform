/**
 * Managed-region editing for generated files. A region is a pair of line comments
 * `// pwtap:<key>` … `// pwtap:<key>:end`; `add`/`remove` splice lines between them idempotently.
 * If a marker is missing (a user deleted it) `locate` throws a `MarkerError` so the caller can print
 * a paste-block instead of making a half-edit.
 *
 * @example
 * let src = addToRegion(barrel, 'plugins:tests', '  maestroTest,', 'maestroTest');
 * src = removeFromRegion(src, 'plugins:tests', 'maestroTest');
 */

export class MarkerError extends Error {
  constructor(public readonly key: string) {
    super(`[pwtap] managed region '${key}' markers not found`);
    this.name = 'MarkerError';
  }
}

const startMarker = (key: string): string => `// pwtap:${key}`;
const endMarker = (key: string): string => `// pwtap:${key}:end`;

function locate(source: string, key: string): { start: number; end: number; lines: string[] } {
  const lines = source.split('\n');
  const start = lines.findIndex(l => l.trim() === startMarker(key));
  const end = lines.findIndex(l => l.trim() === endMarker(key));
  if (start === -1 || end === -1 || end < start) {
    throw new MarkerError(key);
  }
  return { start, end, lines };
}

export function hasRegion(source: string, key: string): boolean {
  return source.includes(startMarker(key)) && source.includes(endMarker(key));
}

/** Insert `line` before the end marker of `key`, unless `uniq` already appears in the region. */
export function addToRegion(source: string, key: string, line: string, uniq: string): string {
  const { start, end, lines } = locate(source, key);
  const region = lines.slice(start + 1, end);
  if (region.some(l => l.includes(uniq))) {
    return source; // already present — idempotent
  }
  lines.splice(end, 0, line);
  return lines.join('\n');
}

/** Remove every line inside `key`'s region that contains `uniq`. */
export function removeFromRegion(source: string, key: string, uniq: string): string {
  const { start, end, lines } = locate(source, key);
  const before = lines.slice(0, start + 1);
  const inside = lines.slice(start + 1, end).filter(l => !l.includes(uniq));
  const after = lines.slice(end);
  return [...before, ...inside, ...after].join('\n');
}
