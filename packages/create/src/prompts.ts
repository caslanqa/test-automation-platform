import { stdin, stdout } from 'node:process';
import { emitKeypressEvents } from 'node:readline';
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

  /**
   * Present selectable plugins as an arrow-key checkbox list (↑/↓ move, space toggle, enter
   * confirm) — coming-soon entries are shown but never land the cursor. Returns the chosen ids.
   */
  async selectPlugins(plugins: KnownPlugin[]): Promise<string[]> {
    const selectable = plugins.filter(p => p.status !== 'coming-soon');
    if (!this.interactive || selectable.length === 0) {
      return plugins.filter(p => p.defaultSelected && p.status !== 'coming-soon').map(p => p.id);
    }
    // The checkbox reads raw keypresses directly off stdin. Close the shared line-reading
    // interface first (it's recreated lazily by the next text()/confirm() call) so nothing else is
    // listening on stdin while we do manual cursor/keypress handling — no interaction between the
    // two input modes to reason about.
    this.rl?.close();
    this.rl = undefined;
    return checkboxPrompt(plugins);
  }

  close(): void {
    this.rl?.close();
  }
}

/** Arrow-key checkbox list over `plugins`; resolves with the ids of the checked, selectable ones. */
function checkboxPrompt(plugins: KnownPlugin[]): Promise<string[]> {
  return new Promise(resolve => {
    const selectableIndexes = plugins
      .map((p, i) => (p.status === 'coming-soon' ? -1 : i))
      .filter(i => i !== -1);
    const checked = new Set(
      plugins
        .map((p, i) => (p.defaultSelected && p.status !== 'coming-soon' ? i : -1))
        .filter(i => i !== -1),
    );
    let cursor = selectableIndexes[0];

    const step = (delta: 1 | -1): void => {
      const pos = selectableIndexes.indexOf(cursor);
      cursor =
        selectableIndexes[(pos + delta + selectableIndexes.length) % selectableIndexes.length];
    };

    const lineFor = (plugin: KnownPlugin, i: number): string => {
      const pointer = i === cursor ? '>' : ' ';
      const box = plugin.status === 'coming-soon' ? '[-]' : checked.has(i) ? '[x]' : '[ ]';
      const tag = plugin.status === 'coming-soon' ? ' [coming soon]' : '';
      return `${pointer} ${box} [${plugin.category}] ${plugin.package} — ${plugin.description}${tag}`;
    };

    let rendered = false;
    const render = (): void => {
      if (rendered) {
        stdout.write(`\x1b[${plugins.length}A`); // cursor up to the first item line
      }
      for (const [i, plugin] of plugins.entries()) {
        stdout.write(`\x1b[2K\r${lineFor(plugin, i)}\n`); // clear the line, then redraw it
      }
      rendered = true;
    };

    const cleanup = (): void => {
      stdin.off('keypress', onKeypress);
      if (stdin.isTTY) {
        stdin.setRawMode(false);
      }
      stdin.pause();
    };

    const onKeypress = (_str: string, key?: { name?: string; ctrl?: boolean }): void => {
      if (key?.ctrl && key.name === 'c') {
        cleanup();
        stdout.write('\n');
        process.exit(130); // conventional SIGINT exit code
      } else if (key?.name === 'up') {
        step(-1);
        render();
      } else if (key?.name === 'down') {
        step(1);
        render();
      } else if (key?.name === 'space') {
        if (plugins[cursor].status !== 'coming-soon') {
          if (checked.has(cursor)) {
            checked.delete(cursor);
          } else {
            checked.add(cursor);
          }
        }
        render();
      } else if (key?.name === 'return' || key?.name === 'enter') {
        cleanup();
        stdout.write('\n');
        resolve(plugins.filter((p, i) => checked.has(i)).map(p => p.id));
      }
    };

    stdout.write('\nOptional plugins — ↑/↓ move, space toggle, enter confirm:\n');
    render();

    emitKeypressEvents(stdin);
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.on('keypress', onKeypress);
  });
}
