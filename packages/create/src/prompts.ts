import { stdin, stdout } from 'node:process';
import readline from 'node:readline/promises';

import type { KnownPlugin } from './registry.js';

/**
 * Tiny zero-dependency prompter. In non-interactive mode (no TTY or `--yes`) every prompt resolves
 * to its default immediately, so CI and `npm init @pwtap dir -y` never hang.
 *
 * @example
 * const p = new Prompter(false);
 * const name = await p.text('Project name', 'my-tests');
 * p.close();
 */
export class Prompter {
  private readonly interactive: boolean;
  private rl?: readline.Interface;

  constructor(yes: boolean) {
    this.interactive = Boolean(stdin.isTTY) && !yes;
  }

  private io(): readline.Interface {
    if (!this.rl) {
      this.rl = readline.createInterface({ input: stdin, output: stdout });
    }
    return this.rl;
  }

  async text(question: string, def: string): Promise<string> {
    if (!this.interactive) {
      return def;
    }
    const answer = (await this.io().question(`${question} (${def}): `)).trim();
    return answer || def;
  }

  async confirm(question: string, def: boolean): Promise<boolean> {
    if (!this.interactive) {
      return def;
    }
    const hint = def ? 'Y/n' : 'y/N';
    const answer = (await this.io().question(`${question} (${hint}): `)).trim().toLowerCase();
    if (!answer) {
      return def;
    }
    return answer === 'y' || answer === 'yes';
  }

  /** Present selectable plugins (coming-soon shown but not selectable); returns chosen ids. */
  async selectPlugins(plugins: KnownPlugin[]): Promise<string[]> {
    const selectable = plugins.filter(p => p.status !== 'coming-soon');
    if (!this.interactive || selectable.length === 0) {
      return plugins.filter(p => p.defaultSelected && p.status !== 'coming-soon').map(p => p.id);
    }
    stdout.write('\nOptional plugins (comma-separated numbers, blank for none):\n');
    plugins.forEach((p, i) => {
      const n = p.status === 'coming-soon' ? '  -' : ` ${String(i + 1).padStart(2)}`;
      const tag = p.status === 'coming-soon' ? ' [coming soon]' : '';
      stdout.write(`${n}. [${p.category}] ${p.package} — ${p.description}${tag}\n`);
    });
    const answer = await this.io().question('> ');
    const picked = new Set(
      answer
        .split(',')
        .map(s => Number(s.trim()))
        .filter(n => Number.isInteger(n)),
    );
    return plugins.filter((p, i) => picked.has(i + 1) && p.status !== 'coming-soon').map(p => p.id);
  }

  close(): void {
    this.rl?.close();
  }
}
