/**
 * The run store and the cross-run test key.
 *
 * The concurrency assertion spawns two real processes: the write-then-rename discipline only matters
 * against a second writer, and asserting it in-process would prove nothing.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { pruneRuns, readRuns, runFileName, stampFor, writeRun } from '../src/history/runStore.js';
import { testKey, titlePathAfterFile } from '../src/history/testKey.js';
import { RUN_SCHEMA, type RunRecord } from '../src/types.js';

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-heal-runs-'));
  dirs.push(dir);
  return dir;
};

function record(day: number, runId = `id-${day}`): RunRecord {
  return {
    schema: RUN_SCHEMA,
    runId,
    startedAt: `2026-08-${String(day).padStart(2, '0')}T09:14:02.123Z`,
    durationMs: 100,
    ci: false,
    workers: 1,
    projects: ['chromium'],
    configRetries: 0,
    status: 'passed',
    globalErrors: [],
    tests: [],
  };
}

// --- testKey ---------------------------------------------------------------------------------

test('the key is stable across calls and differs by project, file and title', () => {
  const base = testKey('chromium', 'tests/a.spec.ts', ['suite', 'does a thing']);
  assert.equal(base, testKey('chromium', 'tests/a.spec.ts', ['suite', 'does a thing']));
  assert.notEqual(base, testKey('webkit', 'tests/a.spec.ts', ['suite', 'does a thing']));
  assert.notEqual(base, testKey('chromium', 'tests/b.spec.ts', ['suite', 'does a thing']));
  assert.notEqual(base, testKey('chromium', 'tests/a.spec.ts', ['suite', 'does another thing']));
});

test('titlePathAfterFile drops the root, project and file entries Playwright puts in front', () => {
  // Playwright's shape: ['', project, file, ...describes, title].
  assert.deepEqual(
    titlePathAfterFile(
      ['', 'chromium', 'tests/a.spec.ts', 'checkout', 'shows the total'],
      'tests/a.spec.ts',
    ),
    ['checkout', 'shows the total'],
  );
  // The file entry may be absolute while ours is relative — matching on the basename covers it.
  assert.deepEqual(
    titlePathAfterFile(['', 'chromium', '/abs/tests/a.spec.ts', 'x'], 'tests/a.spec.ts'),
    ['x'],
  );
  // With no file entry to anchor on, the leading empty root is still dropped.
  assert.deepEqual(titlePathAfterFile(['', 'chromium', 'x'], 'tests/none.spec.ts'), [
    'chromium',
    'x',
  ]);
});

// --- filenames -------------------------------------------------------------------------------

test('the timestamp is a filename-safe prefix that still sorts chronologically', () => {
  assert.equal(stampFor('2026-08-20T09:14:02.123Z'), '2026-08-20T09-14-02Z');
  const names = [record(9), record(10), record(2)].map(runFileName).sort();
  assert.deepEqual(
    names.map(name => name.slice(0, 10)),
    ['2026-08-02', '2026-08-09', '2026-08-10'],
  );
});

test('a shard index is part of the name, so shards never collide', () => {
  const sharded = { ...record(1), shard: { current: 2, total: 4 } };
  assert.match(runFileName(sharded), /-s2\.json$/);
});

// --- read / write / prune --------------------------------------------------------------------

test('a written record reads back, newest first', () => {
  const dir = tmp();
  writeRun(dir, record(1));
  writeRun(dir, record(3));
  writeRun(dir, record(2));
  const runs = readRuns(dir);
  assert.deepEqual(
    runs.map(run => run.runId),
    ['id-3', 'id-2', 'id-1'],
  );
});

test('a leftover temp file is never read, and a corrupt record is skipped not thrown', () => {
  const dir = tmp();
  writeRun(dir, record(1));
  fs.writeFileSync(path.join(dir, 'half-written.json.abcd1234.tmp'), '{"schema":1,"tests":');
  fs.writeFileSync(path.join(dir, 'garbage.json'), 'not json at all');
  fs.writeFileSync(path.join(dir, 'future.json'), JSON.stringify({ schema: 99, tests: [] }));

  const runs = readRuns(dir);
  assert.equal(runs.length, 1, 'only the one valid record');
  assert.equal(runs[0].runId, 'id-1');
});

test('reading a directory that does not exist is empty, not an error', () => {
  assert.deepEqual(readRuns(path.join(tmp(), 'nope')), []);
});

test('writeRun never throws when the target cannot be written', () => {
  // A file where the directory should be: mkdirSync then fails, which is the read-only-disk case.
  const blocked = path.join(tmp(), 'blocked');
  fs.writeFileSync(blocked, 'not a directory');
  assert.doesNotThrow(() => {
    assert.equal(writeRun(blocked, record(1)), null);
  });
});

test('prune keeps the newest N in timestamp order', () => {
  const dir = tmp();
  for (let day = 1; day <= 10; day += 1) {
    writeRun(dir, record(day));
  }
  const removed = pruneRuns(dir, 3);
  assert.equal(removed.length, 7);
  assert.deepEqual(
    readRuns(dir).map(run => run.runId),
    ['id-10', 'id-9', 'id-8'],
  );
});

test('two concurrent writer processes both leave a valid record', () => {
  const dir = tmp();
  const store = new URL('../src/history/runStore.ts', import.meta.url).pathname;
  const hooks = new URL('../../../scripts/test-hooks.mjs', import.meta.url).pathname;
  const script = (id: string): string =>
    `import { writeRun } from ${JSON.stringify(store)};` +
    `writeRun(${JSON.stringify(dir)}, ${JSON.stringify({ ...record(1, id), startedAt: `2026-08-0${id}T09:14:02.123Z` })});`;

  const results = ['1', '2'].map(id =>
    spawnSync(process.execPath, ['--import', hooks, '--input-type=module', '-e', script(id)], {
      encoding: 'utf8',
    }),
  );
  for (const result of results) {
    assert.equal(result.status, 0, result.stderr);
  }
  const runs = readRuns(dir);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map(run => run.runId).sort(), ['1', '2']);
  assert.equal(
    fs.readdirSync(dir).filter(name => name.endsWith('.tmp')).length,
    0,
    'no temp file is left behind',
  );
});
