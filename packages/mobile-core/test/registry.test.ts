/**
 * Adapter discovery against a real (temporary) `node_modules`. The contract check is only worth anything if
 * discovery actually applies it, so these build stand-in adapter packages on disk and load them through the
 * genuine resolution path rather than stubbing the loader.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { MOBILE_CORE_CONTRACT } from '../src/contract.js';
import { discoverDrivers } from '../src/registry.js';

let root = '';

/** Write a stand-in adapter package exposing `./inspector`, declaring `contract` (omitted when null). */
async function writeAdapter(pkg: string, id: string, contract: number | null): Promise<void> {
  const dir = path.join(root, 'node_modules', pkg);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: pkg,
      version: '1.0.0',
      type: 'module',
      exports: { './inspector': './inspector.js' },
    }),
  );
  await fs.writeFile(
    path.join(dir, 'inspector.js'),
    `export const driver = { id: ${JSON.stringify(id)} };\n${
      contract === null ? '' : `export const contract = ${contract};\n`
    }`,
  );
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pwtap-registry-'));
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test('a project with no adapters installed discovers nothing and reports nothing', async () => {
  const problems: string[] = [];
  const drivers = await discoverDrivers(root, m => problems.push(m));

  assert.deepEqual(drivers, []);
  assert.deepEqual(problems, [], 'probing a package that is simply absent is not a problem');
});

test('an adapter on this contract loads', async () => {
  await writeAdapter('@pwtap/plugin-maestro', 'maestro', MOBILE_CORE_CONTRACT);
  const problems: string[] = [];

  const drivers = await discoverDrivers(root, m => problems.push(m));

  assert.deepEqual(
    drivers.map(d => d.id),
    ['maestro'],
  );
  assert.deepEqual(problems, []);
});

test('an adapter with no contract is skipped and reported, not loaded', async () => {
  await writeAdapter('@pwtap/plugin-appium', 'appium', null);
  const problems: string[] = [];

  const drivers = await discoverDrivers(root, m => problems.push(m));

  assert.deepEqual(
    drivers.map(d => d.id),
    ['maestro'],
    'the compatible adapter still works — one bad adapter must not disable the other',
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /@pwtap\/plugin-appium/);
});
