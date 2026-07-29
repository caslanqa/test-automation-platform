/**
 * Path confinement (ADR-010). The browser UI supplies every save location and browse path, so a bug here
 * is a write outside the project. Two escapes the previous prefix check allowed are asserted directly: a
 * sibling directory whose name starts with the project's, and a symlink pointing out of the tree.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { resolveInsideProject } from '../src/service/paths.js';

let root = '';
let project = '';

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pwtap-paths-'));
  project = path.join(root, 'proj');
  await fs.mkdir(path.join(project, 'tests'), { recursive: true });
  // A sibling whose name starts with the project's — the case a plain `startsWith` lets through.
  await fs.mkdir(path.join(root, 'proj-evil'), { recursive: true });
  await fs.symlink(path.join(root, 'proj-evil'), path.join(project, 'linked'), 'dir');
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test('an ordinary path inside the project resolves', async () => {
  const resolved = await resolveInsideProject(project, 'tests/login.maestro.ts');

  assert.equal(resolved, path.join(await fs.realpath(project), 'tests/login.maestro.ts'));
});

test('the project root itself is inside the project', async () => {
  assert.equal(await resolveInsideProject(project, ''), await fs.realpath(project));
});

test('a traversal out of the project is refused', async () => {
  for (const attempt of ['../proj-evil', '../../etc/passwd', 'tests/../../proj-evil/x.ts']) {
    assert.equal(await resolveInsideProject(project, attempt), undefined, attempt);
  }
});

test('a sibling directory sharing the project name prefix is refused', async () => {
  // `/…/proj-evil`.startsWith('/…/proj') is true, which is why the check compares path segments.
  assert.equal(await resolveInsideProject(project, '../proj-evil/x.ts'), undefined);
});

test('a symlink pointing outside the project is refused', async () => {
  assert.equal(await resolveInsideProject(project, 'linked/x.ts'), undefined);
});

test('a path that does not exist yet is allowed, confined by its nearest real ancestor', async () => {
  const resolved = await resolveInsideProject(project, 'tests/new/deeper/login.maestro.ts');

  assert.equal(
    resolved,
    path.join(await fs.realpath(project), 'tests/new/deeper/login.maestro.ts'),
    'saving into a directory the writer will create must still work',
  );
});
