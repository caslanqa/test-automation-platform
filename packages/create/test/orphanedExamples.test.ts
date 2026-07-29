/**
 * Reporting files left importing a removed plugin.
 *
 * Found by installing the packaged product and removing a plugin: `remove maestro` unwired everything it
 * owned but left the example tests it had installed, so `tsc --noEmit` and `playwright test` both failed on
 * imports of a package that was gone, with nothing explaining it. The files stay — a user may have built on
 * them — so the fix is to name them.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { orphanedExamples } from '../src/injectors/orphanedExamples.js';

let dir = '';

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pwtap-orphans-'));
  await fs.mkdir(path.join(dir, 'tests/maestro'), { recursive: true });
  await fs.mkdir(path.join(dir, 'node_modules/@pwtap/plugin-maestro'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'tests/maestro/settings.maestro.ts'),
    "import { devices } from '@pwtap/plugin-maestro';\n",
  );
  await fs.writeFile(
    path.join(dir, 'tests/maestro/teardown.ts'),
    "const m = await import('@pwtap/plugin-maestro/inspector');\n",
  );
  await fs.writeFile(
    path.join(dir, 'tests/keep.appium.ts'),
    "import { test } from '@fixtures';\n// mentions @pwtap/plugin-maestro in prose only\n",
  );
  await fs.writeFile(
    path.join(dir, 'node_modules/@pwtap/plugin-maestro/index.js'),
    "export * from '@pwtap/plugin-maestro';\n",
  );
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

test('every file importing the removed package is reported, subpaths included', async () => {
  assert.deepEqual(orphanedExamples(dir, ['@pwtap/plugin-maestro']), [
    'tests/maestro/settings.maestro.ts',
    'tests/maestro/teardown.ts',
  ]);
});

test('node_modules is not searched — the point is the user’s own files', async () => {
  const found = orphanedExamples(dir, ['@pwtap/plugin-maestro']);

  assert.ok(!found.some(file => file.includes('node_modules')));
});

test('a prose mention is not an import, so it is not reported', async () => {
  assert.ok(!orphanedExamples(dir, ['@pwtap/plugin-maestro']).includes('tests/keep.appium.ts'));
});

test('removing nothing reports nothing', async () => {
  assert.deepEqual(orphanedExamples(dir, []), []);
});

test('the directories a plugin installed count too, not only files importing it', async () => {
  // An import scan found one of six files when `db` was removed: the others imported knex/mongodb, which left
  // with the plugin, or used a fixture that vanished from the barrel while importing only `@fixtures`. The
  // manifest already declares which directories the plugin created, so there is nothing to guess.
  await fs.mkdir(path.join(dir, 'db/seeds'), { recursive: true });
  await fs.writeFile(path.join(dir, 'db/seeds/example.ts'), "import type { Knex } from 'knex';\n");
  await fs.writeFile(path.join(dir, 'db/knexfile.mjs'), 'export default {};\n');

  const found = orphanedExamples(dir, ['@pwtap/plugin-db'], ['db']);

  assert.deepEqual(found, ['db/knexfile.mjs', 'db/seeds/example.ts']);
});

test('an installed directory is reported even when nothing imports the package', async () => {
  await fs.mkdir(path.join(dir, 'tests/db'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'tests/db/example.spec.ts'),
    "import { test } from '@fixtures';\n",
  );

  assert.deepEqual(orphanedExamples(dir, ['@pwtap/plugin-db'], ['tests/db']), [
    'tests/db/example.spec.ts',
  ]);
});
