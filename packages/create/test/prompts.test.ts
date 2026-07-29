/**
 * The plugin checkbox, drawn onto a modelled terminal so wrapping is actually exercised.
 *
 * A user reported that pressing space duplicated the current line instead of ticking the box. The renderer moved
 * the cursor up by the NUMBER OF PLUGINS, which is only the number of physical rows when no line wraps — and the
 * real entries are 88 to 141 characters, so every one of them wraps at 80 columns. The rows the arithmetic missed
 * stayed on screen and the redraw landed underneath them.
 *
 * Asserting on a screen rather than on the escape stream is the point: the bug is in the arithmetic between the
 * two, and only a model that wraps text the way a terminal does can see it.
 */
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { afterEach, test } from 'node:test';

import { Prompter } from '../src/prompts.js';
import type { KnownPlugin } from '../src/registry.js';

/** The real entries, whose length is the whole point — the longest is 141 characters when rendered. */
const PLUGINS: KnownPlugin[] = [
  {
    id: 'maestro',
    flag: '--maestro',
    package: '@pwtap/plugin-maestro',
    category: 'mobile',
    description: 'Mobile testing with Maestro (Android and iOS)',
    defaultSelected: false,
  },
  {
    id: 'appium',
    flag: '--appium',
    package: '@pwtap/plugin-appium',
    category: 'mobile',
    description: 'Mobile testing with Appium and WebdriverIO (Android and iOS)',
    defaultSelected: false,
  },
  {
    id: 'db',
    flag: '--db',
    package: '@pwtap/plugin-db',
    category: 'data',
    description:
      'Database testing (Postgres/MySQL/MariaDB/SQLite through Knex, plus MongoDB) — query, seed, reset, migrate',
    defaultSelected: false,
  },
  {
    id: 'perf',
    flag: '--perf',
    package: '@pwtap/plugin-perf',
    category: 'perf',
    description: 'Performance and load testing',
    defaultSelected: false,
    status: 'coming-soon',
  },
];

/**
 * Just enough terminal to see wrapping: printable text, `\r`, `\n`, `ESC[2K` and `ESC[<n>A`.
 *
 * Wrapping is the only reason this exists — a cursor-up count is right or wrong depending on it.
 */
class Screen {
  private rows: string[] = [''];
  private row = 0;
  private col = 0;
  private readonly width: number;

  // Written out rather than as a parameter property: Node's strip-only type stripping rejects those.
  constructor(width: number) {
    this.width = width;
  }

  write(chunk: string): void {
    let i = 0;
    while (i < chunk.length) {
      const escape = /^\x1b\[(\d*)([AKJ])/.exec(chunk.slice(i));
      if (escape) {
        const [match, digits, command] = escape;
        if (command === 'A') {
          // A count of 0 means one row, which is why the renderer must not emit it for a single-row list.
          this.row = Math.max(0, this.row - (Number(digits) || 1));
        } else if (command === 'J') {
          // ESC[0J — from the cursor to the end of the screen.
          this.rows[this.row] = (this.rows[this.row] ?? '').slice(0, this.col);
          this.rows.length = this.row + 1;
        } else {
          this.rows[this.row] = ''; // ESC[2K — clear the line
        }
        i += match.length;
        continue;
      }
      const ch = chunk[i++];
      if (ch === '\r') {
        this.col = 0;
      } else if (ch === '\n') {
        this.row += 1;
        this.col = 0;
        this.rows[this.row] ??= '';
      } else {
        const line = (this.rows[this.row] ?? '').padEnd(this.col, ' ');
        this.rows[this.row] = line.slice(0, this.col) + ch + line.slice(this.col + 1);
        this.col += 1;
        if (this.col >= this.width) {
          this.row += 1;
          this.col = 0;
          this.rows[this.row] ??= '';
        }
      }
    }
  }

  /** Non-blank lines, which is what a person sees. */
  lines(): string[] {
    return this.rows.map(r => r.trimEnd()).filter(r => r !== '');
  }

  /** How many lines mention this package — must always be exactly 1. */
  countOf(pkg: string): number {
    return this.rows.filter(r => r.includes(pkg)).length;
  }

  /**
   * Entry rows that reached the right edge, i.e. wrapped.
   *
   * Only entries, not the header hint above them: wrapped prose still reads fine, whereas a wrapped entry
   * continues on an unindented row and the checkbox column stops lining up.
   */
  wrappedEntryRows(): string[] {
    return this.rows.filter(r => r.includes('@pwtap/') && r.trimEnd().length >= this.width);
  }
}

const realWrite = process.stdout.write.bind(process.stdout);
const realIsTTY = process.stdin.isTTY;
const realSetRawMode = process.stdin.setRawMode?.bind(process.stdin);

afterEach(() => {
  process.stdout.write = realWrite as typeof process.stdout.write;
  process.stdin.isTTY = realIsTTY;
  if (realSetRawMode) {
    process.stdin.setRawMode = realSetRawMode;
  }
  process.stdin.removeAllListeners('keypress');
});

/** Drive the checkbox with `keys`, drawing onto a screen `width` columns wide. */
async function runCheckbox(
  width: number,
  keys: Array<{ name: string }>,
): Promise<{ screen: Screen; chosen: string[] }> {
  const screen = new Screen(width);
  const stdin = process.stdin as unknown as PassThrough & { isTTY?: boolean };
  stdin.isTTY = true;
  process.stdin.setRawMode = (() => process.stdin) as typeof process.stdin.setRawMode;
  process.stdout.write = ((chunk: string) => {
    screen.write(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  Object.defineProperty(process.stdout, 'columns', { value: width, configurable: true });

  const pending = new Prompter(false).selectPlugins(PLUGINS);
  // The prompt attaches its listener synchronously, so the keys can go in right away.
  for (const key of keys) {
    process.stdin.emit('keypress', key.name === 'space' ? ' ' : '', key);
  }
  return { screen, chosen: await pending };
}

test('the list stays one line per plugin when a toggle redraws it', async () => {
  // 80 columns: every real entry wraps, which is the condition the old cursor arithmetic got wrong.
  const { screen, chosen } = await runCheckbox(80, [{ name: 'space' }, { name: 'return' }]);

  for (const plugin of PLUGINS) {
    assert.equal(
      screen.countOf(plugin.package),
      1,
      `${plugin.package} should appear once, not duplicated by the redraw`,
    );
  }
  assert.deepEqual(chosen, ['maestro'], 'and space should have ticked the box under the cursor');
  assert.deepEqual(
    screen.wrappedEntryRows(),
    [],
    'an entry that wraps fragments onto an unindented row',
  );
});

test('moving and toggling repeatedly never accumulates rows', async () => {
  const keys = [
    { name: 'down' },
    { name: 'space' },
    { name: 'down' },
    { name: 'space' },
    { name: 'up' },
    { name: 'space' },
    { name: 'return' },
  ];
  const { screen, chosen } = await runCheckbox(80, keys);

  const items = screen.lines().filter(l => l.includes('@pwtap/'));
  assert.equal(
    items.length,
    PLUGINS.length,
    `expected ${PLUGINS.length} item lines, got:\n${items.join('\n')}`,
  );
  // down, space (appium on), down, space (db on), up, space (appium off) → only db remains.
  assert.deepEqual(chosen, ['db']);
});

test('a narrow terminal truncates every entry instead of wrapping it', async () => {
  // 40 columns would send the longest entry to four rows, so every one of them has to be cut.
  const { screen } = await runCheckbox(40, [
    { name: 'space' },
    { name: 'space' },
    { name: 'return' },
  ]);

  for (const plugin of PLUGINS) {
    assert.equal(screen.countOf(plugin.package), 1, `${plugin.package} duplicated at 40 columns`);
  }
  assert.deepEqual(
    screen.wrappedEntryRows(),
    [],
    'entries must be truncated to the width, not wrapped',
  );
  // Truncation has to be visible as such, or a cut description reads as the whole description.
  assert.ok(
    screen.lines().some(l => l.endsWith('…')),
    'a cut entry should end in an ellipsis',
  );
});

test('a coming-soon entry cannot be ticked', async () => {
  // Three downs from the first selectable entry wraps past `perf` back to the start, since it is skipped.
  const { chosen } = await runCheckbox(80, [
    { name: 'down' },
    { name: 'down' },
    { name: 'down' },
    { name: 'space' },
    { name: 'return' },
  ]);
  assert.deepEqual(chosen, ['maestro'], 'the cursor should have wrapped to maestro, skipping perf');
});
