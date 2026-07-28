/**
 * Fixture-barrel injection tests, run against a real temporary project directory.
 *
 * This is the machinery that decides whether `import { test } from '@fixtures'` actually gives a project
 * the fixtures its tests ask for. The case worth guarding hardest is the shared one: both mobile plugins
 * contribute the same driver-neutral `mobileApp` facade, so it must be injected exactly once and must
 * survive removing one of them — a naive removal strips it out from under every remaining
 * inspector-generated test, which then fails with an unknown-fixture error.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { applyFixture, removeFixture } from '../src/injectors/fixturesBarrel.js';
import type { PluginManifest } from '../src/manifest.js';

const SHARED = {
  importFrom: '@pwtap/mobile-inspector',
  test: { alias: 'mobileAppTest' },
  shared: true,
} as const;

const MAESTRO: PluginManifest = {
  id: 'maestro',
  name: '@pwtap/plugin-maestro',
  devDependencies: {},
  scripts: {},
  envKeys: {},
  fixture: [{ importFrom: '@pwtap/plugin-maestro', test: { alias: 'maestroTest' } }, SHARED],
};

const APPIUM: PluginManifest = {
  id: 'appium',
  name: '@pwtap/plugin-appium',
  devDependencies: {},
  scripts: {},
  envKeys: {},
  fixture: [{ importFrom: '@pwtap/plugin-appium', test: { alias: 'appiumTest' } }, SHARED],
};

const AI_JUDGE: PluginManifest = {
  id: 'ai-judge',
  name: '@pwtap/plugin-ai-judge',
  devDependencies: {},
  scripts: {},
  envKeys: {},
  // The single-object form, still used by matcher-only plugins — must keep working.
  fixture: { importFrom: '@pwtap/plugin-ai-judge', expect: { alias: 'judgeExpect' } },
};

const BARREL = `import { mergeExpects, mergeTests } from '@playwright/test';

import { test as uiTest, expect as uiExpect } from './ui';

// pwtap:plugins:imports
// pwtap:plugins:imports:end

export const test = mergeTests(
  uiTest,
  // pwtap:plugins:tests
  // pwtap:plugins:tests:end
);

export const expect = mergeExpects(
  uiExpect,
  // pwtap:plugins:expects
  // pwtap:plugins:expects:end
);
`;

/** A throwaway client project containing just the barrel. */
function project(): { dir: string; barrel: () => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-barrel-'));
  fs.mkdirSync(path.join(dir, 'fixtures'), { recursive: true });
  const file = path.join(dir, 'fixtures', 'index.ts');
  fs.writeFileSync(file, BARREL, 'utf8');
  return { dir, barrel: () => fs.readFileSync(file, 'utf8') };
}

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

test('a plugin with several fixtures injects all of them', () => {
  const { dir, barrel } = project();

  assert.equal(applyFixture(dir, MAESTRO), true);

  const src = barrel();
  assert.match(src, /import \{ test as maestroTest \} from '@pwtap\/plugin-maestro';/);
  assert.match(src, /import \{ test as mobileAppTest \} from '@pwtap\/mobile-inspector';/);
  assert.match(src, /^ {2}maestroTest,$/m);
  assert.match(src, /^ {2}mobileAppTest,$/m);
});

test('the shared fixture is injected once when both mobile plugins are installed', () => {
  const { dir, barrel } = project();

  applyFixture(dir, MAESTRO);
  applyFixture(dir, APPIUM);

  const src = barrel();
  assert.equal(occurrences(src, "from '@pwtap/mobile-inspector'"), 1, 'duplicate import');
  assert.equal(occurrences(src, 'mobileAppTest,'), 1, 'duplicate mergeTests argument');
  // Both drivers' own fixtures are still there alongside it.
  assert.equal(occurrences(src, 'maestroTest,'), 1);
  assert.equal(occurrences(src, 'appiumTest,'), 1);
});

test('applying the same plugin twice changes nothing', () => {
  const { dir, barrel } = project();

  applyFixture(dir, MAESTRO);
  const once = barrel();
  applyFixture(dir, MAESTRO);

  assert.equal(barrel(), once, 'injection must be idempotent');
});

test('removing one mobile plugin KEEPS the shared fixture the other still needs', () => {
  const { dir, barrel } = project();
  applyFixture(dir, MAESTRO);
  applyFixture(dir, APPIUM);

  // Appium is still installed, so it still contributes the shared entry.
  removeFixture(dir, MAESTRO, new Set(['@pwtap/mobile-inspector']));

  const src = barrel();
  assert.doesNotMatch(src, /maestroTest/, "maestro's own fixture must go");
  assert.doesNotMatch(src, /@pwtap\/plugin-maestro/);
  assert.match(src, /mobileAppTest,/, 'the shared fixture must survive');
  assert.match(src, /appiumTest,/);
});

test('removing the last mobile plugin also removes the shared fixture', () => {
  const { dir, barrel } = project();
  applyFixture(dir, MAESTRO);

  // Nothing else contributes it any more.
  removeFixture(dir, MAESTRO, new Set());

  const src = barrel();
  assert.doesNotMatch(src, /maestroTest/);
  assert.doesNotMatch(src, /mobileAppTest/);
  assert.doesNotMatch(src, /@pwtap\/mobile-inspector/);
});

test('a matcher-only plugin still works with the single-object form', () => {
  const { dir, barrel } = project();

  assert.equal(applyFixture(dir, AI_JUDGE), true);

  const src = barrel();
  assert.match(src, /import \{ expect as judgeExpect \} from '@pwtap\/plugin-ai-judge';/);
  assert.match(src, /^ {2}judgeExpect,$/m);
  assert.doesNotMatch(src, /judgeExpect,\n {2}judgeExpect/, 'expects region only');

  removeFixture(dir, AI_JUDGE);
  assert.doesNotMatch(barrel(), /judgeExpect/);
});

test('a barrel whose markers were deleted is reported, not half-edited', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-barrel-'));
  fs.mkdirSync(path.join(dir, 'fixtures'), { recursive: true });
  const file = path.join(dir, 'fixtures', 'index.ts');
  const mangled = BARREL.replace('// pwtap:plugins:tests\n', '');
  fs.writeFileSync(file, mangled, 'utf8');

  assert.equal(applyFixture(dir, MAESTRO), false, 'must refuse rather than write a broken barrel');
  assert.equal(fs.readFileSync(file, 'utf8'), mangled, 'the file must be left untouched');
});
