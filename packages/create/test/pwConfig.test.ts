/**
 * The reporter injector. Three properties, and each one is a way the existing marker machinery is
 * supposed to protect a user's config:
 *
 * - applying twice yields **one** line (idempotent, via `addToRegion`'s `uniq`);
 * - add then remove restores the file **byte for byte** (symmetric);
 * - a missing marker returns false and **writes nothing**, so the caller prints a paste block rather
 *   than making a half-edit.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { applyReporter, removeReporter } from '../src/injectors/pwConfig.js';
import type { PluginManifest } from '../src/manifest.js';

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const CONFIG_WITH_REGION = `import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['list'],
    // pwtap:plugins:reporters
    // pwtap:plugins:reporters:end
  ],
});
`;

const CONFIG_WITHOUT_REGION = `import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [['html'], ['list']],
});
`;

const manifest: PluginManifest = {
  id: 'heal',
  name: '@pwtap/plugin-heal',
  devDependencies: {},
  scripts: {},
  envKeys: {},
  reporter: {
    uniq: '@pwtap/plugin-heal/reporter',
    line: "    ['@pwtap/plugin-heal/reporter', { runsDir: '.heal/runs' }],",
  },
};

function project(config: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-pwconfig-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'playwright.config.ts'), config);
  return dir;
}

const read = (dir: string): string =>
  fs.readFileSync(path.join(dir, 'playwright.config.ts'), 'utf8');

test('the reporter lands inside the managed region, not anywhere else in the array', () => {
  const dir = project(CONFIG_WITH_REGION);
  assert.equal(applyReporter(dir, manifest), true);

  const lines = read(dir).split('\n');
  const start = lines.findIndex(line => line.trim() === '// pwtap:plugins:reporters');
  const end = lines.findIndex(line => line.trim() === '// pwtap:plugins:reporters:end');
  const injected = lines.findIndex(line => line.includes('@pwtap/plugin-heal/reporter'));
  assert.ok(injected > start && injected < end, 'it must be between the markers');
  assert.ok(lines[injected].startsWith('    ['), 'and indented as an array entry');
});

test('applying twice yields one line', () => {
  const dir = project(CONFIG_WITH_REGION);
  applyReporter(dir, manifest);
  applyReporter(dir, manifest);
  const occurrences = read(dir).split('@pwtap/plugin-heal/reporter').length - 1;
  assert.equal(occurrences, 1);
});

test('add then remove restores the file byte for byte', () => {
  const dir = project(CONFIG_WITH_REGION);
  applyReporter(dir, manifest);
  assert.notEqual(read(dir), CONFIG_WITH_REGION);
  removeReporter(dir, manifest);
  assert.equal(read(dir), CONFIG_WITH_REGION);
});

test('a missing marker returns false and writes nothing', () => {
  const dir = project(CONFIG_WITHOUT_REGION);
  assert.equal(applyReporter(dir, manifest), false);
  assert.equal(read(dir), CONFIG_WITHOUT_REGION, 'a half-edit is worse than no edit');
});

test('removing from a config with no marker is a no-op, not a throw', () => {
  const dir = project(CONFIG_WITHOUT_REGION);
  assert.doesNotThrow(() => removeReporter(dir, manifest));
  assert.equal(read(dir), CONFIG_WITHOUT_REGION);
});

test('a manifest with no reporter is left alone by both directions', () => {
  const dir = project(CONFIG_WITH_REGION);
  const plain: PluginManifest = { ...manifest, reporter: undefined };
  assert.equal(applyReporter(dir, plain), true, 'nothing to do is success, not failure');
  removeReporter(dir, plain);
  assert.equal(read(dir), CONFIG_WITH_REGION);
});

test('removing one plugin leaves another plugin’s reporter in place', () => {
  const dir = project(CONFIG_WITH_REGION);
  const other: PluginManifest = {
    ...manifest,
    id: 'other',
    name: '@example/other',
    reporter: { uniq: '@example/other/reporter', line: "    ['@example/other/reporter']," },
  };
  applyReporter(dir, manifest);
  applyReporter(dir, other);
  removeReporter(dir, manifest);

  const after = read(dir);
  assert.equal(after.includes('@pwtap/plugin-heal/reporter'), false);
  assert.ok(after.includes('@example/other/reporter'));
});
