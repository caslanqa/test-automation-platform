/**
 * The project README a plugin contributes to.
 *
 * Found by auditing my own work on `plugin-db`: every manifest already declared `readmeSection` — `ai-judge`
 * wrote a substantial one — and nothing read the field. A scaffolded project had no README at all, so the first
 * place a teammate looks to learn what the suite can do was empty while four plugins carried the answer.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { applyReadme, removeReadme } from '../src/injectors/readme.js';
import type { PluginManifest } from '../src/manifest.js';

let dir = '';
const readme = (): string => fs.readFileSync(path.join(dir, 'README.md'), 'utf8');

/** Only the fields this injector reads; the rest of a manifest is irrelevant here. */
const plugin = (id: string, section?: string): PluginManifest =>
  ({ id, name: `@pwtap/plugin-${id}`, readmeSection: section }) as PluginManifest;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-readme-'));
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the first plugin with something to say creates the README', () => {
  applyReadme(dir, plugin('db', '## Database\n\nTwo fixture families.'));

  assert.match(readme(), /^# Test suite/, 'a project with no README gets a usable one');
  assert.match(readme(), /## Database/);
  assert.match(
    readme(),
    /maintained by `create-pwtap add\|remove`/,
    'and says which parts are managed',
  );
});

test('a second plugin lands alongside the first, not on top of it', () => {
  applyReadme(dir, plugin('ai-judge', '## AI Judge\n\nRubric matchers.'));

  assert.match(readme(), /## Database/);
  assert.match(readme(), /## AI Judge/);
});

test('adding the same plugin again replaces its section rather than duplicating it', () => {
  applyReadme(dir, plugin('db', '## Database\n\nRewritten.'));

  assert.equal(readme().match(/## Database/g)?.length, 1);
  assert.match(readme(), /Rewritten\./);
  assert.doesNotMatch(readme(), /Two fixture families/, 'the stale copy must be gone');
});

test('removing one plugin leaves every other section intact', () => {
  removeReadme(dir, plugin('db'));

  assert.doesNotMatch(readme(), /## Database/);
  assert.match(readme(), /## AI Judge/, "the other plugin's section must survive");
  assert.match(readme(), /^# Test suite/, 'and so must the user’s own content');
});

test('a plugin with nothing to say writes nothing at all', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-readme-empty-'));
  try {
    applyReadme(empty, plugin('quiet'));
    applyReadme(empty, plugin('blank', '   '));

    assert.equal(fs.existsSync(path.join(empty, 'README.md')), false, 'no section, no file');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('removing from a project that has no README is not an error', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-readme-none-'));
  try {
    removeReadme(empty, plugin('db'));
    assert.equal(fs.existsSync(path.join(empty, 'README.md')), false);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
