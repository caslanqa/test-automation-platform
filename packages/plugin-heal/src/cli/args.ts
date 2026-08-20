/**
 * Argument reading, hand-rolled. Zero runtime dependencies is this package's budget, and a flag
 * parser is twenty lines — `@pwtap/create` does the same thing for the same reason.
 *
 * @example
 * flagValue(argv, '--json');      // '--json x' or '--json=x'
 * flagNumber(argv, '--max', 5);   // falls back when absent or not a number
 */

export function flagPresent(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
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

/** Positional arguments, in order, excluding flags and their values. */
export function positionals(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('-')) {
      // A flag with a separate value consumes the next token.
      if (!arg.includes('=') && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) {
        i += 1;
      }
      continue;
    }
    out.push(arg);
  }
  return out;
}
