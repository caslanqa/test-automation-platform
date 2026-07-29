/**
 * Directory browsing for the save dialog. Before this the dialog had the user type a location blind, so
 * a typo became "cannot read tests" at save time. The listing is server-side because the browser cannot
 * read the project, and it is confined to the project because the browser chooses the path.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import type { RecorderEvent } from '../src/service/protocol.js';
import { TestWriter } from '../src/service/testWriter.js';

let project = '';

before(async () => {
  project = await fs.mkdtemp(path.join(os.tmpdir(), 'pwtap-writer-'));
  for (const dir of ['tests/mobile', 'tests/api', 'node_modules/pkg', '.cache', 'dist']) {
    await fs.mkdir(path.join(project, dir), { recursive: true });
  }
  await fs.writeFile(path.join(project, 'tests/login.maestro.ts'), '// test\n');
});

after(async () => {
  await fs.rm(project, { recursive: true, force: true });
});

/** Collect what the writer emits for one command. */
async function listDirs(relative?: string): Promise<RecorderEvent[]> {
  const events: RecorderEvent[] = [];
  await new TestWriter(project, event => events.push(event)).listDirs(relative);
  return events;
}

test('the project root lists as the empty path, so the UI can label it', async () => {
  assert.deepEqual(await listDirs(''), [{ type: 'dirs', path: '', entries: ['tests'] }]);
});

test('build output, dependencies and dotfiles are left out of the listing', async () => {
  const [event] = await listDirs('');

  assert.ok(event.type === 'dirs');
  assert.deepEqual(event.entries, ['tests'], 'node_modules, dist and .cache are noise here');
});

test('subdirectories are listed sorted, and files are not', async () => {
  assert.deepEqual(await listDirs('tests'), [
    { type: 'dirs', path: 'tests', entries: ['api', 'mobile'] },
  ]);
});

test('a path outside the project is refused rather than listed', async () => {
  const [event] = await listDirs('../..');

  assert.equal(event.type, 'error');
});

test('an unreadable path reports which path failed', async () => {
  const [event] = await listDirs('tests/nope');

  assert.ok(event.type === 'error');
  assert.match(event.message, /tests\/nope/);
});
