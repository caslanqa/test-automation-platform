/**
 * Argument reading, hand-rolled. One runtime dependency is this package's budget and it is already
 * spent on the vendor reporter; a flag parser is forty lines. Deliberately the same shape as
 * `@pwtap/plugin-heal`'s — a shared package for this would be a published API surface in exchange for
 * forty lines nobody edits.
 *
 * Positionals come before flags in every command this CLI defines (`tms run create --title x`), which is
 * what keeps {@link positionals} simple: it assumes a flag may consume the token after it.
 *
 * @example
 * flagValue(argv, '--title');       // '--title x' or '--title=x'
 * flagNumber(argv, '--plan', undefined);
 */

export function flagPresent(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag) || argv.some(arg => arg.startsWith(`${flag}=`));
}

export function flagValue(argv: readonly string[], flag: string): string | undefined {
  const inline = argv.find(arg => arg.startsWith(`${flag}=`));
  if (inline !== undefined) {
    return inline.slice(flag.length + 1);
  }
  const at = argv.indexOf(flag);
  const next = at === -1 ? undefined : argv[at + 1];
  return next !== undefined && !next.startsWith('-') ? next : undefined;
}

export function flagNumber(
  argv: readonly string[],
  flag: string,
  fallback: number | undefined,
): number | undefined {
  const raw = flagValue(argv, flag);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** `--tags a,b,c` → `['a','b','c']`; absent or empty → `[]`. */
export function flagList(argv: readonly string[], flag: string): string[] {
  return (flagValue(argv, flag) ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(part => part !== '');
}

/** Positional arguments, in order, excluding flags and their values. */
export function positionals(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) {
        i += 1;
      }
      continue;
    }
    out.push(arg);
  }
  return out;
}
